export class ApiError extends Error{
  constructor(message,status){super(message);this.status=status}
}
export async function api(path,options){
  if(['/play','/stop','/cam/set'].includes(new URL(path,'http://internal').pathname)&&!options?.method)options={...options,method:'POST'};
  const response=await fetch(path,options);
  let data;try{data=await response.json()}catch{throw new ApiError('서버 응답 오류 ('+response.status+')',response.status)}
  if(!response.ok)throw new ApiError(data.error||String(response.status),response.status);
  return data;
}
