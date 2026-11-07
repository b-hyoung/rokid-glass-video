// Export the known working Git revision, not the modified working tree.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const dir=import.meta.dirname,root=resolve(dir,'../..');
const ref=execFileSync('git',['rev-parse','b321635^{commit}'],{cwd:root,encoding:'utf8'}).trim();
const files=execFileSync('git',['ls-tree','-r','--name-only',ref,'server','demo'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
const hashes={};
for(const path of files){
  const data=execFileSync('git',['show',`${ref}:${path}`],{cwd:root,maxBuffer:64*1024*1024});
  const dest=join(dir,'build',path);mkdirSync(resolve(dest,'..'),{recursive:true});writeFileSync(dest,data);
  if(!readFileSync(dest).equals(data))throw Error('Source export mismatch: '+path);
  hashes[path]=createHash('sha256').update(data).digest('hex');
}
writeFileSync(join(dir,'build','source.json'),JSON.stringify({ref,files:hashes},null,2)+'\n');
console.log(`Exported and verified ${files.length} original files from ${ref}`);
