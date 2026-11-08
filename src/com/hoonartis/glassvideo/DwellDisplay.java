package com.hoonartis.glassvideo;

/** Uses the server's lease so a delayed status sample pauses rather than resets. */
final class DwellDisplay {
    static boolean visible(long expiresAt, long serverNow, long elapsedSinceSample,
                           boolean focused, boolean locked) {
        return focused && !locked && expiresAt > serverNow + Math.max(0, elapsedSinceSample);
    }
}
