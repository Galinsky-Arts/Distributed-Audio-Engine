package org.neophilism.dae;

/** One route's timestamp model. Discontinuities require explicit rejoin, not replay.
 * This is an estimated presentation timeline, not acoustic calibration. */
final class FrameClock {
    static final double DEFAULT_TOLERANCE_MS=10;
    private final double period, toleranceMs;
    private long previousRaw=-1, wraps=0, previousNanos=-1, previousWritten=-1;
    private double anchor=Double.NaN;
    FrameClock(int rate) { this(rate,DEFAULT_TOLERANCE_MS); }
    FrameClock(int rate,double toleranceMs) {
        if(rate<8000||rate>192000)throw new IllegalArgumentException("INVALID_RATE");
        if(!(toleranceMs>=1&&toleranceMs<=250))throw new IllegalArgumentException("INVALID_CLOCK_TOLERANCE");
        period=1000.0/rate;this.toleranceMs=toleranceMs;
    }
    double observe(long rawPosition,long timestampNanos,long written,double nowMs) {
        long raw=rawPosition&0xffffffffL;
        if(timestampNanos<0 || timestampNanos<previousNanos || written<previousWritten ||
           !Double.isFinite(nowMs) || Math.abs(timestampNanos/1_000_000.0-nowMs)>2000)
            throw new IllegalStateException("TIMESTAMP_DISCONTINUITY");
        long nextWraps=wraps;
        if(previousRaw>=0 && raw<previousRaw) {
            if(previousRaw-raw>0x80000000L)nextWraps+=1L<<32;
            else throw new IllegalStateException("FRAME_ROLLBACK");
        }
        long presented=nextWraps+raw;
        if(written<presented || written-presented>192000)throw new IllegalStateException("FRAME_RANGE_INVALID");
        double observedAnchor=timestampNanos/1_000_000.0-presented*period;
        if(Double.isNaN(anchor))anchor=observedAnchor;
        else if(Math.abs(observedAnchor-anchor)>toleranceMs)throw new IllegalStateException("CLOCK_REJOIN_REQUIRED");
        wraps=nextWraps;previousRaw=raw;previousNanos=timestampNanos;previousWritten=written;
        return anchor+written*period;
    }
}
