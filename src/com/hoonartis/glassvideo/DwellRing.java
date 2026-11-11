package com.hoonartis.glassvideo;

/**
 * Smooth dwell ring. Server progress arrives only with each recognition result,
 * so between results the ring advances on the local clock (at most LEAD_MS past
 * the last sample) and never steps backward for the same focus. It stops just
 * short of full until the server confirms playback, then closes the circle.
 */
final class DwellRing {
    static final long LEAD_MS = 750, COMPLETE_HOLD_MS = 450;
    static final float PENDING_CAP = .98f;
    private String focus = "";
    private float value, floor, server;
    private long at = -1, completeUntil;

    String focus() { return focus; }

    private void reset(long now) { focus = ""; value = 0; floor = 0; server = 0; completeUntil = 0; at = now; }

    /** Returns the sweep fraction (0..1) to draw; 0 hides the ring. */
    float step(long now, String sampleFocus, double progress, boolean advancing, long sinceMs, long dwellMs, boolean completed) {
        long dt = at < 0 ? 0 : Math.min(50, Math.max(0, now - at));
        at = now;
        if (completed && !focus.isEmpty() && focus.equals(sampleFocus) && completeUntil == 0) completeUntil = now + COMPLETE_HOLD_MS;
        float goal;
        if (completeUntil != 0 && now < completeUntil) goal = 1;
        else if (completeUntil != 0 || sampleFocus == null || sampleFocus.isEmpty()) { reset(now); return 0; }
        else {
            if (!sampleFocus.equals(focus)) { reset(now); focus = sampleFocus; }
            double lead = advancing ? Math.min(LEAD_MS, Math.max(0, sinceMs)) / (double) Math.max(1, dwellMs) : 0;
            float p = (float) (Double.isNaN(progress) ? 0 : progress);
            float sample = (float) Math.max(0, Math.min(PENDING_CAP, p + lead));
            // Only a drop in the server's own progress (a resume with less credit) lowers the ring.
            floor = p < server - .05f ? sample : Math.max(floor, sample);
            server = p;
            goal = floor;
        }
        value += (goal - value) * (float) (1 - Math.exp(-dt / (goal == 1 ? 40.0 : 65.0)));
        if (Math.abs(goal - value) < .002f) value = goal;
        return value;
    }
}
