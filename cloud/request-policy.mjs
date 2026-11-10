export const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export const DWELL_MS=1500;
export const FOCUS_RESUME_MS=2500;
export const DISPLAY_HOLD_MS=850;
// Longest frame-to-frame interval that still counts as one continuous
// observation for dwell. Slower analysis cycles earn their real frame time up
// to this cap instead of a fixed 350ms (or 150ms resume) slice.
export const MAX_DWELL_CREDIT_MS=1000;

// Shared by HTTP and state-channel result submission. Transport never grants
// stale evidence extra time or changes the identity/dwell rules.
export function acceptDetectionEnvelope(data,{now,guideEnabled,active,epoch,frameAt}){
  return Number.isFinite(data?.at)&&!guideEnabled&&active&&data.epoch===epoch&&
    data.at>=frameAt&&now-data.at<=1500&&data.at<=now+500;
}
