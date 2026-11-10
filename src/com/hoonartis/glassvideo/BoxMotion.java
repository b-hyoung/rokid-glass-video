package com.hoonartis.glassvideo;

/** Moves a server box along its measured velocity to cover display latency.
 * The lead is bounded in time and distance so a sudden stop overshoots little. */
final class BoxMotion {
    static final long MAX_LEAD_MS = 250;
    static final double MAX_SHIFT = .08;   // frame units
    static final double MIN_SPEED = .02;   // frame units per second
    private BoxMotion() {}

    /** Offset in frame units for a box observed {@code ageMs} ago. */
    static double[] offset(double vx, double vy, long ageMs) {
        if (!Double.isFinite(vx) || !Double.isFinite(vy) || ageMs <= 0) return new double[]{0, 0};
        if (Math.hypot(vx, vy) < MIN_SPEED) return new double[]{0, 0};
        double lead = Math.min(MAX_LEAD_MS, ageMs) / 1000.0;
        double dx = vx * lead, dy = vy * lead, length = Math.hypot(dx, dy);
        if (length > MAX_SHIFT) { dx *= MAX_SHIFT / length; dy *= MAX_SHIFT / length; }
        return new double[]{dx, dy};
    }
}
