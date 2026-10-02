import { Clock } from "../../application/ports/clock";

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
