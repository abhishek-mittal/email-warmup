import { Injectable } from '@nestjs/common';

export type WarmupSpeed = 'slow' | 'medium' | 'fast';

const MAX_DAILY_VOLUME = 200;

// Waypoints from __specs__/services/warmup-engine.md — [warmupDay, dailyVolume] pairs,
// sorted ascending by day. Linear interpolation between consecutive waypoints.
const WAYPOINTS: Record<WarmupSpeed, [number, number][]> = {
  slow: [
    [1, 2],
    [14, 8],
    [28, 20],
    [42, 40],
    [56, 80],
  ],
  medium: [
    [1, 3],
    [7, 10],
    [14, 25],
    [21, 50],
    [35, 100],
  ],
  fast: [
    [1, 5],
    [5, 15],
    [10, 40],
    [15, 80],
    [21, 150],
  ],
};

@Injectable()
export class RampService {
  /**
   * Computes today's target warmup send volume for a given speed/day by linearly
   * interpolating between the curve's waypoints. Days before the first waypoint
   * clamp to the first waypoint's value; days after the last waypoint hold steady
   * at the last waypoint's value. Result is rounded to the nearest integer and
   * capped at MAX_DAILY_VOLUME.
   */
  getDailyVolume(speed: WarmupSpeed, warmupDay: number): number {
    const points = WAYPOINTS[speed];

    if (warmupDay <= points[0][0]) {
      return Math.min(points[0][1], MAX_DAILY_VOLUME);
    }

    const last = points[points.length - 1];
    if (warmupDay >= last[0]) {
      return Math.min(last[1], MAX_DAILY_VOLUME);
    }

    for (let i = 0; i < points.length - 1; i++) {
      const [dayA, volA] = points[i];
      const [dayB, volB] = points[i + 1];
      if (warmupDay >= dayA && warmupDay <= dayB) {
        const slope = (volB - volA) / (dayB - dayA);
        const interpolated = volA + slope * (warmupDay - dayA);
        return Math.min(Math.round(interpolated), MAX_DAILY_VOLUME);
      }
    }

    // Unreachable given the clamps above, but keeps the function total.
    return Math.min(last[1], MAX_DAILY_VOLUME);
  }
}
