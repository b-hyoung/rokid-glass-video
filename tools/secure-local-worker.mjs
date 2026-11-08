import localWorker from './local-worker.mjs';
import {secureFetch} from '../cloud/session-access.mjs';
export {LocalGlassRoom,LocalPreviewRoom} from './local-worker.mjs';
export {PairingRegistry} from '../cloud/session-access.mjs';
export default {fetch(request,env){return secureFetch(request,env,(authorized,scoped)=>localWorker.fetch(authorized,scoped))}};
