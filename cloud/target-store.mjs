export const MAX_TARGETS = 12;
export const MAX_IMAGES = 60;

export class TargetStore {
  constructor(storage) {
    this.sql = storage.sql;
    this.storage = storage;
    const migrate = () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, name TEXT, key TEXT, image TEXT)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS target_images (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, image TEXT NOT NULL, created_at INTEGER NOT NULL)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS target_images_target ON target_images(target_id)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS target_image_info (image_id TEXT PRIMARY KEY,info TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS target_batches (id TEXT PRIMARY KEY,target_id TEXT NOT NULL,result TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS target_vectors (target_id TEXT PRIMARY KEY, pack TEXT NOT NULL)');
      // Preserve existing IDs and images, then clear the old column so deleted views never reappear.
      this.sql.exec("INSERT OR IGNORE INTO target_images SELECT id || ':initial', id, image, 0 FROM targets WHERE image IS NOT NULL AND image != ''");
      this.sql.exec('UPDATE targets SET image = NULL WHERE image IS NOT NULL');
    };
    storage.transactionSync(migrate);
  }
  invalidate(){this.metadata=null}
  mutate(fn){try{return this.storage.transactionSync(fn)}finally{this.invalidate()}}
  list(withImages = false) {
    if(!withImages){
      if(!this.metadata)this.metadata=this.sql.exec(`SELECT t.id,t.name,t.key,
        (SELECT COUNT(*) FROM target_images i WHERE i.target_id=t.id) AS imageCount,
        CASE WHEN v.target_id IS NULL THEN 0 ELSE 1 END AS hasVectors
        FROM targets t LEFT JOIN target_vectors v ON v.target_id=t.id ORDER BY t.rowid`).toArray()
        .map(t=>({...t,hasVectors:!!t.hasVectors}));
      return this.metadata.map(t=>({...t}));
    }
    const images=new Map();
    for(const row of this.sql.exec(`SELECT i.target_id,i.id,i.image,i.created_at,m.info
      FROM target_images i LEFT JOIN target_image_info m ON m.image_id=i.id ORDER BY i.created_at,i.id`).toArray()){
      const {target_id,info,...image}=row;
      if(info)image.capture=JSON.parse(info);
      if(!images.has(target_id))images.set(target_id,[]);
      images.get(target_id).push(image);
    }
    return this.sql.exec(`SELECT t.id,t.name,t.key,v.pack FROM targets t
      LEFT JOIN target_vectors v ON v.target_id=t.id ORDER BY t.rowid`).toArray().map(({pack,...target})=>{
      const views=images.get(target.id)||[];
      return {...target,appearance:pack?JSON.parse(pack):null,imageCount:views.length,images:views,image:views[0]?.image??null};
    });
  }
  get(id) { return this.sql.exec('SELECT id,name,key FROM targets WHERE id=?', id).toArray()[0]; }
  create(name, key, image) {
    if (this.list().length >= MAX_TARGETS) throw new Error(`대상은 최대 ${MAX_TARGETS}개까지 등록할 수 있습니다.`);
    const id = crypto.randomUUID();
    this.mutate(()=>{
      this.sql.exec('INSERT INTO targets (id,name,key,image) VALUES (?,?,?,NULL)', id, name, key);
      this.addImage(id, image);
    });
    return id;
  }
  saveVectors({targetId, name, key, pack, images=[]}) {
    return this.mutate(() => {
      if (!targetId) {
        if (this.list().length >= MAX_TARGETS) throw Error(`대상은 최대 ${MAX_TARGETS}개까지 등록할 수 있습니다.`);
        targetId = crypto.randomUUID();
        this.sql.exec('INSERT INTO targets VALUES (?,?,?,NULL)', targetId, name, key);
      }
      if (!this.get(targetId)) throw Error('대상을 찾을 수 없습니다.');
      this.sql.exec('INSERT OR REPLACE INTO target_vectors VALUES (?,?)', targetId, JSON.stringify(pack));
      for (const image of images) this.addImage(targetId, image);
      return targetId;
    });
  }
  deleteVectors(id) {
    this.mutate(() => {
      this.sql.exec('DELETE FROM target_vectors WHERE target_id=?', id);
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM target_images WHERE target_id=?', id).toArray()[0].n;
      if (!count) this.sql.exec('DELETE FROM targets WHERE id=?', id);
    });
  }
  addImage(targetId, image) {
    if (!this.get(targetId)) throw new Error('대상을 찾을 수 없습니다. 목록을 새로고침해 주세요.');
    const images = this.sql.exec('SELECT id FROM target_images WHERE target_id=?', targetId).toArray();
    if (images.length >= MAX_IMAGES) throw new Error(`대상 하나에 이미지는 최대 ${MAX_IMAGES}장까지 등록할 수 있습니다.`);
    const id = crypto.randomUUID();
    this.sql.exec('INSERT INTO target_images VALUES (?,?,?,?)', id, targetId, image, Date.now());
    this.invalidate();
    return id;
  }
  addBatch({targetId,name,key,images,batchId}) {
    return this.mutate(()=>{
      const prior=this.sql.exec('SELECT result FROM target_batches WHERE id=?',batchId).toArray()[0];if(prior)return JSON.parse(prior.result);
      if(!targetId){if(this.list().length>=MAX_TARGETS)throw Error(`대상은 최대 ${MAX_TARGETS}개까지 등록할 수 있습니다.`);targetId=crypto.randomUUID();this.sql.exec('INSERT INTO targets VALUES (?,?,?,NULL)',targetId,name,key)}
      if(!this.get(targetId))throw Error('대상을 찾을 수 없습니다.');
      const count=this.sql.exec('SELECT COUNT(*) AS n FROM target_images WHERE target_id=?',targetId).toArray()[0].n;
      if(count+images.length>MAX_IMAGES)throw Error(`저장할 수 있는 이미지는 ${MAX_IMAGES-count}장입니다.`);
      const imageIds=images.map(item=>{const id=this.addImage(targetId,item.image);if(item.capture)this.sql.exec('INSERT INTO target_image_info VALUES (?,?)',id,JSON.stringify(item.capture));return id});
      const result={ok:true,targetId,imageIds,count:imageIds.length};this.sql.exec('INSERT INTO target_batches VALUES (?,?,?)',batchId,targetId,JSON.stringify(result));return result;
    });
  }
  deleteImage(targetId, id) {this.sql.exec('DELETE FROM target_image_info WHERE image_id IN (SELECT id FROM target_images WHERE target_id=? AND id=?)',targetId,id);this.sql.exec('DELETE FROM target_images WHERE target_id=? AND id=?', targetId, id); this.invalidate(); }
  deleteTarget(id) {
    this.mutate(()=>{
      this.sql.exec('DELETE FROM target_image_info WHERE image_id IN (SELECT id FROM target_images WHERE target_id=?)',id);
      this.sql.exec('DELETE FROM target_batches WHERE target_id=?',id);
      this.sql.exec('DELETE FROM target_images WHERE target_id=?', id);
      this.sql.exec('DELETE FROM target_vectors WHERE target_id=?', id);
      this.sql.exec('DELETE FROM targets WHERE id=?', id);
    });
  }
}
