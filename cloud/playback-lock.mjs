// The lock covers loading as well as playback. The app renews it while playing;
// token checks keep a late completion from unlocking a newer manual selection.
export class PlaybackLock {
  constructor(storage) {
    this.storage=storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS playback_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const row=storage.sql.exec('SELECT data FROM playback_state WHERE id=1').toArray()[0];
    try{this.value=row?JSON.parse(row.data):null}catch{this.value=null}
    this.revision=0;
  }
  save(){this.storage.sql.exec('INSERT OR REPLACE INTO playback_state VALUES (1,?)',JSON.stringify(this.value));this.revision++}
  current(now=Date.now()) {
    if(this.value&&now-this.value.at>30000){this.value=null;this.save()}
    return this.value;
  }
  begin(source,targetId=null,media=null) {
    const now=Date.now();
    this.value={id:crypto.randomUUID(),source,targetId,media,state:'loading',at:now,issuedAt:now};this.save();return this.value;
  }
  event(id,event) {
    if(!this.value||this.value.id!==id)return false;
    if(['loading','playing'].includes(event)){this.value={...this.value,state:event,at:Date.now()};this.save();return true}
    if(['stopped','completed','error','rejected'].includes(event)){this.value=null;this.save();return true}
    return false;
  }
  stop(){this.value=null;this.save()}
}
