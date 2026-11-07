import {unpack} from './stream-protocol.mjs';
// Incremental binary HTTP response; retain at most one incomplete 4MB packet.
export async function readVideo(body,receive,signal,onRead=()=>null){
  const reader=body.getReader();let buffer=new Uint8Array();
  try{while(!signal.aborted){const {value,done}=await reader.read();if(done)break;const read=onRead(value.byteLength);
    const joined=new Uint8Array(buffer.length+value.length);joined.set(buffer);joined.set(value,buffer.length);buffer=joined;
    let offset=0;
    while(buffer.length-offset>=4){const size=new DataView(buffer.buffer,buffer.byteOffset+offset,4).getUint32(0);if(size<4||size>4*1024*1024)throw Error('잘못된 영상 패킷');if(buffer.length-offset<4+size)break;
      const {meta,bytes}=unpack(buffer.slice(offset+4,offset+4+size).buffer);await receive({...meta,bytes},read);offset+=size+4;
    }
    buffer=buffer.slice(offset);
  }if(!signal.aborted&&buffer.length)throw Error('영상 연결이 패킷 중간에 끊겼습니다.');}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
