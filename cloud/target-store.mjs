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
  list(withImages = false) {
    return this.sql.exec('SELECT id,name,key FROM targets ORDER BY rowid').toArray().map(target => {
      if (!withImages) {
        const count=this.sql.exec('SELECT COUNT(*) AS n FROM target_images WHERE target_id=?',target.id).toArray()[0].n;
        const hasVectors = !!this.sql.exec('SELECT 1 FROM target_vectors WHERE target_id=?',target.id).toArray().length;
        return {...target,imageCount:count,hasVectors};
      }
      const entry = this.sql.exec('SELECT pack FROM target_vectors WHERE target_id=?', target.id).toArray()[0];
      const appearance = entry ? JSON.parse(entry.pack) : null;
      const images = this.sql.exec('SELECT id,image,created_at FROM target_images WHERE target_id=? ORDER BY created_at,id', target.id).toArray().map(image=>{const meta=this.sql.exec('SELECT info FROM target_image_info WHERE image_id=?',image.id).toArray()[0];return {...image,...(meta?{capture:JSON.parse(meta.info)}:{})}});
      return {...target, appearance, imageCount: images.length, ...(withImages ? {images, image: images[0]?.image ?? null} : {})};
    });
  }
  get(id) { return this.sql.exec('SELECT id,name,key FROM targets WHERE id=?', id).toArray()[0]; }
  create(name, key, image) {
    if (this.list().length >= MAX_TARGETS) throw new Error(`대상은 최대 ${MAX_TARGETS}개까지 등록할 수 있습니다.`);
    const id = crypto.randomUUID();
    this.storage.transactionSync(()=>{
      this.sql.exec('INSERT INTO targets (id,name,key,image) VALUES (?,?,?,NULL)', id, name, key);
      this.addImage(id, image);
    });
    return id;
  }
  saveVectors({targetId, name, key, pack, images=[]}) {
    return this.storage.transactionSync(() => {
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
    this.storage.transactionSync(() => {
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
    return id;
  }
  addBatch({targetId,name,key,images,batchId}) {
    return this.storage.transactionSync(()=>{
      const prior=this.sql.exec('SELECT result FROM target_batches WHERE id=?',batchId).toArray()[0];if(prior)return JSON.parse(prior.result);
      if(!targetId){if(this.list().length>=MAX_TARGETS)throw Error(`대상은 최대 ${MAX_TARGETS}개까지 등록할 수 있습니다.`);targetId=crypto.randomUUID();this.sql.exec('INSERT INTO targets VALUES (?,?,?,NULL)',targetId,name,key)}
      if(!this.get(targetId))throw Error('대상을 찾을 수 없습니다.');
      const count=this.sql.exec('SELECT COUNT(*) AS n FROM target_images WHERE target_id=?',targetId).toArray()[0].n;
      if(count+images.length>MAX_IMAGES)throw Error(`저장할 수 있는 이미지는 ${MAX_IMAGES-count}장입니다.`);
      const imageIds=images.map(item=>{const id=this.addImage(targetId,item.image);if(item.capture)this.sql.exec('INSERT INTO target_image_info VALUES (?,?)',id,JSON.stringify(item.capture));return id});
      const result={ok:true,targetId,imageIds,count:imageIds.length};this.sql.exec('INSERT INTO target_batches VALUES (?,?,?)',batchId,targetId,JSON.stringify(result));return result;
    });
  }
  deleteImage(targetId, id) {this.sql.exec('DELETE FROM target_image_info WHERE image_id IN (SELECT id FROM target_images WHERE target_id=? AND id=?)',targetId,id);this.sql.exec('DELETE FROM target_images WHERE target_id=? AND id=?', targetId, id); }
  deleteTarget(id) {
    this.storage.transactionSync(()=>{
      this.sql.exec('DELETE FROM target_image_info WHERE image_id IN (SELECT id FROM target_images WHERE target_id=?)',id);
      this.sql.exec('DELETE FROM target_batches WHERE target_id=?',id);
      this.sql.exec('DELETE FROM target_images WHERE target_id=?', id);
      this.sql.exec('DELETE FROM target_vectors WHERE target_id=?', id);
      this.sql.exec('DELETE FROM targets WHERE id=?', id);
    });
  }
}
