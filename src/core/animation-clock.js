/**
 * Sprite Sheet Builder V2.0 — Animation Timeline & Monotonic Clock (Spec §9).
 * Pure deterministic playback engine supporting loop, once, pingpong, per-frame durationMs,
 * empty slots (preserved, never skipped), single-frame groups, and hidden-tab pause without catch-up burst.
 */

import { LIMITS } from './constants.js';

/**
 * Compute exact duration (ms) for a frame slot without cumulative rounding drift.
 */
export function getFrameDurationMs(frame, fps, useCustomDurations = true) {
  if (useCustomDurations && frame && typeof frame.durationMs === 'number' && Number.isFinite(frame.durationMs)) {
    return Math.max(LIMITS.MIN_DURATION_MS, Math.min(LIMITS.MAX_DURATION_MS, frame.durationMs));
  }
  const safeFps = Number.isFinite(fps) && fps >= LIMITS.MIN_FPS && fps <= LIMITS.MAX_FPS ? fps : 8;
  return 1000 / safeFps;
}

/**
 * Build explicit playback sequence of frame indices for a cycle.
 * For pingpong:
 * - n = 0 -> []
 * - n = 1 -> [0] (no duplicate/glitch)
 * - n = 2 -> [0, 1] (oscillating 0 -> 1 -> 0 -> 1 without repeating endpoints consecutively)
 * - n = 4 -> [0, 1, 2, 3, 2, 1] (no consecutive endpoint repeats!)
 */
export function buildPlaybackOrder(frameCount, loopMode = 'loop') {
  if (!Number.isInteger(frameCount) || frameCount <= 0) return [];
  if (loopMode !== 'pingpong' || frameCount <= 2) {
    return Array.from({ length: frameCount }, (_, i) => i);
  }
  const seq = [];
  for (let i = 0; i < frameCount; i++) seq.push(i);
  for (let i = frameCount - 2; i >= 1; i--) seq.push(i);
  return seq;
}

export class AnimationClock {
  constructor() {
    this.playing = false;
    this.pausedByVisibility = false;
    this.seqIndex = 0;
    this.elapsedInSlotMs = 0;
    this.lastTimestampMs = null;
    this.useCustomDurations = true;
  }

  reset() {
    this.playing = false;
    this.pausedByVisibility = false;
    this.seqIndex = 0;
    this.elapsedInSlotMs = 0;
    this.lastTimestampMs = null;
  }

  stop() {
    this.playing = false;
    this.pausedByVisibility = false;
    this.seqIndex = 0;
    this.elapsedInSlotMs = 0;
    this.lastTimestampMs = null;
  }

  play(animation, nowMs = null) {
    if (!animation || !animation.frames || animation.frames.length === 0) {
      this.playing = false;
      return false;
    }
    if (animation.loopMode === 'once') {
      const order = buildPlaybackOrder(animation.frames.length, 'once');
      if (this.seqIndex >= order.length - 1 && !this.playing) {
        this.seqIndex = 0;
        this.elapsedInSlotMs = 0;
      }
    }
    this.playing = true;
    this.pausedByVisibility = false;
    this.lastTimestampMs = nowMs;
    return true;
  }

  pause() {
    this.playing = false;
    this.lastTimestampMs = null;
  }

  /**
   * Called when tab becomes hidden/blurred: pauses playback and keeps current frame,
   * preventing catch-up bursts when returning (Spec §9).
   */
  handleVisibilityHidden() {
    if (this.playing) {
      this.playing = false;
      this.pausedByVisibility = true;
      this.lastTimestampMs = null;
    }
  }

  getCurrentFrameIndex(animation) {
    if (!animation || !animation.frames || animation.frames.length === 0) return -1;
    const order = buildPlaybackOrder(animation.frames.length, animation.loopMode);
    if (order.length === 0) return -1;
    const clamped = Math.max(0, Math.min(order.length - 1, this.seqIndex));
    return order[clamped];
  }

  setFrameIndex(animation, frameIndex) {
    if (!animation || !animation.frames || animation.frames.length === 0) {
      this.seqIndex = 0;
      this.elapsedInSlotMs = 0;
      return -1;
    }
    const clamped = Math.max(0, Math.min(animation.frames.length - 1, frameIndex));
    this.seqIndex = clamped;
    this.elapsedInSlotMs = 0;
    this.lastTimestampMs = null;
    return clamped;
  }

  step(animation, deltaSteps) {
    if (!animation || !animation.frames || animation.frames.length === 0) return -1;
    const n = animation.frames.length;
    const cur = this.getCurrentFrameIndex(animation);
    const next = ((cur + deltaSteps) % n + n) % n;
    this.seqIndex = next;
    this.elapsedInSlotMs = 0;
    this.lastTimestampMs = null;
    return next;
  }

  /**
   * Ensure clock index remains valid after project revision changes (Spec §9).
   */
  syncWithAnimation(animation) {
    if (!animation || !animation.frames || animation.frames.length === 0) {
      this.stop();
      return -1;
    }
    const order = buildPlaybackOrder(animation.frames.length, animation.loopMode);
    if (this.seqIndex >= order.length) {
      this.seqIndex = Math.max(0, order.length - 1);
      this.elapsedInSlotMs = 0;
    }
    return order[this.seqIndex];
  }

  /**
   * Advance playback using a monotonic timestamp (e.g. from requestAnimationFrame).
   * Caps single delta to avoid infinite loops if tab suspended before visibility event.
   */
  tick(animation, nowMs) {
    if (!animation || !animation.frames || animation.frames.length === 0) {
      this.stop();
      return { frameIndex: -1, changed: false, ended: true };
    }
    const order = buildPlaybackOrder(animation.frames.length, animation.loopMode);
    if (this.seqIndex >= order.length) {
      this.seqIndex = 0;
      this.elapsedInSlotMs = 0;
    }

    if (!this.playing) {
      return { frameIndex: order[this.seqIndex], changed: false, ended: false };
    }

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = nowMs;
      return { frameIndex: order[this.seqIndex], changed: false, ended: false };
    }

    let dt = nowMs - this.lastTimestampMs;
    this.lastTimestampMs = nowMs;

    if (!Number.isFinite(dt) || dt <= 0) {
      return { frameIndex: order[this.seqIndex], changed: false, ended: false };
    }

    // Clamp massive suspend jumps (> 250ms) so browser sleep never replays thousands of frames
    if (dt > 250) dt = 250;

    if (order.length === 1) {
      // Single-frame group: never glitch ping-pong or spin infinitely
      if (animation.loopMode === 'once') {
        const dur = getFrameDurationMs(animation.frames[0], animation.fps, this.useCustomDurations);
        this.elapsedInSlotMs += dt;
        if (this.elapsedInSlotMs >= dur) {
          this.elapsedInSlotMs = dur;
          this.playing = false;
          return { frameIndex: 0, changed: false, ended: true };
        }
      }
      return { frameIndex: 0, changed: false, ended: false };
    }

    const prevFrame = order[this.seqIndex];
    this.elapsedInSlotMs += dt;
    let safety = 0;
    let ended = false;

    while (safety < 64) {
      safety++;
      const curFrameObj = animation.frames[order[this.seqIndex]];
      const dur = getFrameDurationMs(curFrameObj, animation.fps, this.useCustomDurations);
      if (this.elapsedInSlotMs < dur) break;

      this.elapsedInSlotMs -= dur;
      if (this.seqIndex + 1 < order.length) {
        this.seqIndex += 1;
      } else if (animation.loopMode === 'once') {
        this.elapsedInSlotMs = 0;
        this.playing = false;
        ended = true;
        break;
      } else {
        this.seqIndex = 0;
      }
    }

    const nextFrame = order[this.seqIndex];
    return { frameIndex: nextFrame, changed: nextFrame !== prevFrame, ended };
  }
}
