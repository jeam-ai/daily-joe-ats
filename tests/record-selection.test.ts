import test from "node:test";
import assert from "node:assert/strict";
import { recordHold } from "../lib/record-selection";
function fixture() {
  const selected: string[] = [];
  let time = 0;
  const jobs = new Set<{ at: number; callback: () => void }>();
  const gesture = recordHold(
    (id) => selected.push(id),
    (callback, ms) => {
      const job = { at: time + ms, callback };
      jobs.add(job);
      return () => {
        jobs.delete(job);
      };
    },
  );
  const advance = (ms: number) => {
    time += ms;
    for (const job of [...jobs])
      if (job.at <= time) {
        jobs.delete(job);
        job.callback();
      }
  };
  return { gesture, selected, advance };
}
test("a quick tap opens normally; a long press selects once and consumes the profile click", () => {
  const { gesture, selected, advance } = fixture();
  gesture.begin("applicant-1", 20, 20);
  advance(200);
  gesture.end();
  advance(400);
  assert.deepEqual(selected, []);
  assert.equal(gesture.consumeClick(), false);
  gesture.begin("applicant-2", 20, 20);
  advance(550);
  advance(600);
  assert.deepEqual(selected, ["applicant-2"]);
  gesture.end();
  assert.equal(gesture.consumeClick(), true);
  assert.equal(gesture.consumeClick(), false);
});
test("scroll, pointer cancellation and leaving a record prevent accidental selection", () => {
  const { gesture, selected, advance } = fixture();
  gesture.begin("scrolling", 20, 20);
  gesture.move(20, 35);
  advance(600);
  gesture.begin("cancelled", 20, 20);
  gesture.abort();
  advance(600);
  gesture.begin("left", 20, 20);
  gesture.cancel();
  advance(600);
  assert.deepEqual(selected, []);
});
test("a subsequent tap is never blocked even when a touch browser omits the synthetic click", () => {
  const { gesture, advance } = fixture();
  gesture.begin("first", 10, 10);
  advance(550);
  gesture.end();
  advance(500);
  assert.equal(gesture.held(), false);
  gesture.begin("second", 10, 10);
  gesture.end();
  assert.equal(gesture.consumeClick(), false);
});
