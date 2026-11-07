import {Container} from '@cloudflare/containers';

// This comparison deployment uses a separate name and never switches the live room.
export class OriginalServer extends Container {
  defaultPort=8787;
  sleepAfter='2m';
  envVars={PORT:'8787'};
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/server.txt')return new Response(url.origin+'\n',{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
    const server=env.ORIGINAL.get(env.ORIGINAL.idFromName('original-camera'),{locationHint:'apac'});
    return server.fetch(request);
  }
};
