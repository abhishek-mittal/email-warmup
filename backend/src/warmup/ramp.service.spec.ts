import { Test, TestingModule } from '@nestjs/testing';
import { RampService } from './ramp.service';

describe('RampService', () => {
  let service: RampService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RampService],
    }).compile();
    service = module.get<RampService>(RampService);
  });

  describe('getDailyVolume', () => {
    it('returns the exact waypoint value at slow day 1', () => {
      expect(service.getDailyVolume('slow', 1)).toBe(2);
    });

    it('returns the exact waypoint value at slow day 56', () => {
      expect(service.getDailyVolume('slow', 56)).toBe(80);
    });

    it('interpolates linearly between slow waypoints (day 21, halfway between day14=8 and day28=20)', () => {
      // day 14 = 8, day 28 = 20 -> slope = 12/14 = 0.857142..., day21 = 8 + 7*0.857142.. = 14
      expect(service.getDailyVolume('slow', 21)).toBe(14);
    });

    it('returns the exact waypoint value at medium day 7 (acceptance criterion: 10 jobs)', () => {
      expect(service.getDailyVolume('medium', 7)).toBe(10);
    });

    it('interpolates linearly between medium waypoints (day 28, halfway between day21=50 and day35=100)', () => {
      expect(service.getDailyVolume('medium', 28)).toBe(75);
    });

    it('returns the exact waypoint value at fast day 21', () => {
      expect(service.getDailyVolume('fast', 21)).toBe(150);
    });

    it('interpolates linearly between fast waypoints (day 12.5-equivalent rounding, day 13 between day10=40 and day15=80)', () => {
      // day10=40, day15=80 -> slope = 40/5 = 8/day; day13 = 40 + 3*8 = 64
      expect(service.getDailyVolume('fast', 13)).toBe(64);
    });

    it('clamps output to max 200 beyond the last waypoint', () => {
      expect(service.getDailyVolume('fast', 21)).toBeLessThanOrEqual(200);
      expect(service.getDailyVolume('fast', 100)).toBeLessThanOrEqual(200);
    });

    it('holds the last waypoint value steady for days beyond the final waypoint', () => {
      expect(service.getDailyVolume('medium', 35)).toBe(100);
      expect(service.getDailyVolume('medium', 50)).toBe(100);
    });

    it('returns the first waypoint value for day 0 or before the first waypoint', () => {
      expect(service.getDailyVolume('medium', 0)).toBe(3);
    });

    it('returns an integer (rounded), never a fractional volume', () => {
      const value = service.getDailyVolume('slow', 21);
      expect(Number.isInteger(value)).toBe(true);
    });
  });
});
