"""Run the paired candidate in an isolated local database (no production writes)."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import webbrowser
from start_local import ROOT,RUNTIME,prepare_assets,asset_directory,wrangler_command,api,stop_process,write_if_changed


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8791)
    parser.add_argument('--no-open',action='store_true')
    args=parser.parse_args()
    if not 1024<=args.port<=65535:parser.error('Port must be between 1024 and 65535')
    prepare_assets(args.port)
    private=RUNTIME/f'paired-{args.port}'
    private.mkdir(parents=True,exist_ok=True)
    key_file=private/'secrets.json'
    if not key_file.exists():
        key_file.write_text(json.dumps({'SESSION_SECRET':secrets.token_urlsafe(32),'SETUP_SECRET':secrets.token_urlsafe(32)}),encoding='utf-8')
    keys=json.loads(key_file.read_text(encoding='utf-8'))
    config={'name':'glass-video-paired-local','main':str(ROOT/'tools/secure-local-worker.mjs'),'compatibility_date':'2026-11-01','workers_dev':False,
      'assets':{'directory':str(asset_directory(args.port)),'binding':'ASSETS','run_worker_first':True,'html_handling':'none','not_found_handling':'none'},
      'vars':{'ACCESS_MODE':'paired',**keys},
      'durable_objects':{'bindings':[{'name':'ROOM','class_name':'LocalGlassRoom'},{'name':'PREVIEW','class_name':'LocalPreviewRoom'},{'name':'ACCESS','class_name':'PairingRegistry'}]},
      'migrations':[{'tag':'paired-v1','new_sqlite_classes':['LocalGlassRoom','LocalPreviewRoom','PairingRegistry']}]}
    config_file=private/'wrangler.json'
    write_if_changed(config_file,json.dumps(config))
    setup_url=f'http://localhost:{args.port}/connect#setup='+keys['SETUP_SECRET']
    write_if_changed(private/'owner-link.txt',setup_url)
    for file in [key_file,config_file,private/'owner-link.txt']:
        try:file.chmod(0o600)
        except OSError:pass
    print(f'Paired candidate: http://localhost:{args.port}/connect',flush=True)
    print(f'Private first-setup link: {private / "owner-link.txt"}',flush=True)
    print('Original registrations are preserved; import a backup into a new workspace from the connection page.',flush=True)
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1',args.port))==0:
            if api(args.port,'/runtime-config.json').get('accessMode')!='paired':raise RuntimeError('Port is occupied by another service.')
            if not args.no_open:webbrowser.open(setup_url)
            return
    command=wrangler_command()+['dev','--local','--config',str(config_file),'--ip','0.0.0.0','--port',str(args.port),'--persist-to',str(private/'state')]
    env={**os.environ,'WRANGLER_SEND_METRICS':'false','CI':'true','NO_COLOR':'1'}
    with (private/'server.log').open('a',encoding='utf-8') as log:
        process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        try:
            for _ in range(150):
                if process.poll() is not None:raise RuntimeError('Paired runtime exited; see the private server log.')
                try:
                    if api(args.port,'/runtime-config.json').get('accessMode')=='paired':break
                except (OSError,RuntimeError,ValueError):time.sleep(.2)
            else:raise RuntimeError('Paired runtime startup timed out.')
            print('Ready. Ctrl+C stops only this candidate.',flush=True)
            if not args.no_open:webbrowser.open(setup_url)
            process.wait()
        except KeyboardInterrupt:pass
        finally:stop_process(process)


if __name__=='__main__':
    main()
