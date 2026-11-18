import Anthropic from "@anthropic-ai/sdk";
import type { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  MAX_VISION_IMAGE_BYTES,
  VISION_LIMIT_MESSAGE,
  VisionMealResponse,
} from "@healtheat/shared";
import app from "../src/app.js";
import { MemberProfile, User } from "../src/models/index.js";
import {
  VISION_MODEL,
  VISION_TIMEOUT_MS,
  setVisionClientForTests,
  visionClient,
} from "../src/services/vision.js";
import { refundPhoto, reservePhoto } from "../src/services/visionUsage.js";

// T13: POST /api/vision/meal (design doc, REST table and the vision amendment R3-17/R3-29). The Anthropic
// client is replaced by a fake; nothing here calls the network.

const PHOTO = {
  image: Buffer.from("not really a jpeg").toString("base64"),
  mediaType: "image/jpeg",
};
type ParseArgs = Record<string, unknown> & { messages: unknown; system: string };

/** A fake client whose beta.messages.parse runs `answer` and records each request. */
function fakeClient(answer: (args: ParseArgs) => unknown) {
  const calls: ParseArgs[] = [];
  const client = {
    beta: {
      messages: {
        parse: vi.fn(async (args: ParseArgs) => {
          calls.push(args);
          return answer(args);
        }),
      },
    },
  };
  setVisionClientForTests(client as unknown as Pick<Anthropic, "beta">);
  return { client, calls };
}

const ok = (items: unknown[]) => () => ({
  content: [],
  stop_reason: "end_turn",
  stop_details: null,
  parsed_output: { items },
});

async function member(username: string, timezone = "UTC") {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      password: "correct horse battery",
      timezone,
    })
    .expect(201);
  const user = (await User.findOne({ username }))!;
  return { agent, user };
}
const usage = async (userId: Types.ObjectId) => {
  const u = (await MemberProfile.findOne({ userId }, { visionUsage: 1 }).lean())?.visionUsage;
  return u ? { ...(u.date ? { date: u.date } : {}), count: u.count } : null;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
});
afterEach(() => {
  setVisionClientForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/vision/meal", () => {
  // Value: protects=a photo returns the proposed items (out-of-range ones dropped), counts one photo, and
  //   the request asks claude-opus-5-5 for structured output with server-side fallbacks and a system
  //   prompt that forbids nutrient estimates; fails_when=the model, fallbacks or no-nutrients rule drift,
  //   or a bad item fails the whole photo; why_new=new route; seam=setVisionClientForTests;
  //   no_claim=what the real model sees in a photo (T18 eval)
  // Extended by /ship coverage audit (T13).
  // Value: protects=an item whose query is only whitespace is dropped, not offered as a blank USDA
  //   search; fails_when=the trim moves after the VisionItem check; why_new=the row above only trims a
  //   padded name; seam=setVisionClientForTests; no_claim=none beyond protects
  it("returns the proposed items, counts the photo and asks for structured output", async () => {
    const { calls } = fakeClient(
      ok([
        { query: " white rice, cooked ", grams: 180, confidence: 0.8 },
        { query: "chicken breast", grams: 120, confidence: 0.6 },
        { query: "sauce", grams: -5, confidence: 0.3 }, // impossible portion: dropped
        { query: "   ", grams: 40, confidence: 0.5 }, // blank once trimmed: dropped
      ]),
    );
    const { agent, user } = await member("snap");
    const body = VisionMealResponse.parse(
      (await agent.post("/api/vision/meal").send(PHOTO).expect(200)).body,
    );
    expect(body).toEqual({
      items: [
        { query: "white rice, cooked", grams: 180, confidence: 0.8 },
        { query: "chicken breast", grams: 120, confidence: 0.6 },
      ],
      remainingToday: 19,
    });
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 1 });

    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args).toMatchObject({
      model: VISION_MODEL,
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
    expect(VISION_MODEL).toBe("claude-opus-5-5");
    expect(args.system).toMatch(/Do not estimate calories/);
    expect(JSON.stringify(args.messages)).toContain(PHOTO.image);
  });

  // Value: protects=a timeout, an upstream 5xx and a refusal answer 504/502/422 with a message the web
  //   shows as "Try again", and none of them uses one of the day's photos; fails_when=the reserved photo
  //   is not refunded on failure, or errors surface as 500s; why_new=amendment R3-17/R3-29 (failures
  //   not charged); seam=setVisionClientForTests; no_claim=the real client's timer
  // Extended by /ship coverage audit (T13).
  // Value: protects=an upstream 401 (bad app key) and a dropped connection both answer 502 vision_failed,
  //   never relaying the upstream 401 as the member's own; fails_when=APIError status is passed through
  //   or a connection error maps to 504; why_new=table only had a 500; seam=setVisionClientForTests;
  //   no_claim=the SDK's real error classes for live failures (constructed here)
  it("charges nothing for a timeout, an upstream error or a refusal", async () => {
    const { agent, user } = await member("flaky");
    fakeClient(ok([{ query: "apple", grams: 150, confidence: 0.9 }]));
    await agent.post("/api/vision/meal").send(PHOTO).expect(200);
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 1 });

    const failures: [() => unknown, number, string][] = [
      [
        () => {
          throw new Anthropic.APIConnectionTimeoutError();
        },
        504,
        "vision_timeout",
      ],
      [
        () => {
          throw new Anthropic.InternalServerError(500, undefined, "overloaded", new Headers());
        },
        502,
        "vision_failed",
      ],
      [
        () => ({
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: null },
          parsed_output: null,
        }),
        422,
        "vision_refused",
      ],
      [
        () => ({ content: [], stop_reason: "max_tokens", parsed_output: null }),
        502,
        "vision_failed",
      ],
      [
        () => {
          throw new Anthropic.AuthenticationError(
            401,
            undefined,
            "invalid x-api-key",
            new Headers(),
          );
        },
        502,
        "vision_failed",
      ],
      [
        () => {
          throw new Anthropic.APIConnectionError({ message: "socket hang up" });
        },
        502,
        "vision_failed",
      ],
    ];
    for (const [answer, status, error] of failures) {
      fakeClient(answer);
      const res = await agent.post("/api/vision/meal").send(PHOTO);
      expect({ status: res.status, error: res.body.error }).toEqual({ status, error });
      expect(typeof res.body.details).toBe("string");
      expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 1 });
    }
  });

  // Value: protects=the 21st photo of the member's day is 429 with the doc's message and never reaches
  //   Claude, and the next local day starts again at 1; fails_when=the limit is off by one, the counter
  //   never resets, or a refused photo still calls the model; why_new=REST table limit; seam=none;
  //   no_claim=web rendering of the message
  it("refuses the 21st photo of the day and resets on the next local day", async () => {
    const { client } = fakeClient(ok([]));
    const { agent, user } = await member("shutter");
    for (let i = 0; i < 20; i++) await agent.post("/api/vision/meal").send(PHOTO).expect(200);
    const res = await agent.post("/api/vision/meal").send(PHOTO).expect(429);
    expect(res.body).toMatchObject({ error: "vision_limit", details: VISION_LIMIT_MESSAGE });
    expect(client.beta.messages.parse).toHaveBeenCalledTimes(20);
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 20 });

    vi.setSystemTime(new Date("2026-11-17T00:30:00Z"));
    const next = VisionMealResponse.parse(
      (await agent.post("/api/vision/meal").send(PHOTO).expect(200)).body,
    );
    expect(next.remainingToday).toBe(19);
    expect(await usage(user._id)).toEqual({ date: "2026-11-17", count: 1 });
  });

  // Value: protects=concurrent photos never exceed 20 a day (the counter is one atomic write per
  //   photo, including the first of the day); fails_when=a read-then-write lets parallel requests past
  //   the limit or loses counts; why_new=atomic counter (design doc C5); seam=none; no_claim=a sharded
  //   database
  it("counts concurrent photos atomically, first of the day included", async () => {
    fakeClient(ok([]));
    const { agent, user } = await member("burst");
    const statuses = await Promise.all(
      Array.from({ length: 25 }, () =>
        agent
          .post("/api/vision/meal")
          .send(PHOTO)
          .then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 20 });
  });

  // Value: protects="today" is the member's local date (a UTC+8 member past local midnight is on the next
  //   day); fails_when=the counter keys on the UTC date; why_new=plan OV10; seam=none; no_claim=DST edges
  it("keys the counter on the member's local date", async () => {
    fakeClient(ok([]));
    vi.setSystemTime(new Date("2026-11-16T18:30:00Z")); // 02:30 on 2026-11-17 in Taipei
    const { agent, user } = await member("taipei", "Asia/Taipei");
    await agent.post("/api/vision/meal").send(PHOTO).expect(200);
    expect(await usage(user._id)).toEqual({ date: "2026-11-17", count: 1 });
  });

  // Generated by /ship coverage audit (T13).
  // Value: protects=a failed refund is logged and the member still gets the original 504, not a 500;
  //   fails_when=the .catch on refundPhoto is dropped so the refund error replaces the Claude error;
  //   why_new=no test made the refund itself fail; seam=none; no_claim=how often the refund write fails
  //   (rejection simulated with a spy on MemberProfile.updateOne)
  it("keeps the original error when the refund write fails", async () => {
    const { agent } = await member("norefund");
    fakeClient(() => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    vi.spyOn(MemberProfile, "updateOne").mockRejectedValueOnce(new Error("db write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await agent.post("/api/vision/meal").send(PHOTO);
    expect({ status: res.status, error: res.body.error }).toEqual({
      status: 504,
      error: "vision_timeout",
    });
    expect(logged).toHaveBeenCalledWith("[vision] refund failed:", expect.any(Error));
  });

  // Generated by /ship coverage audit (T13).
  // Value: protects=a photo of exactly MAX_VISION_IMAGE_BYTES decoded bytes is accepted and one byte more
  //   is 413, through both base64 padding forms; fails_when=decodedBytes ignores "=" or "==" padding or
  //   the comparison goes >=; why_new=the 413 test uses an unpadded 705 KB photo only; seam=none;
  //   no_claim=the browser's downsizing keeps real photos under the limit
  it("accepts a photo at the size limit and refuses one byte more", async () => {
    const { client } = fakeClient(ok([]));
    const { agent } = await member("edgecase");
    const atLimit = Buffer.alloc(MAX_VISION_IMAGE_BYTES).toString("base64");
    expect(atLimit.endsWith("==")).toBe(true);
    await agent
      .post("/api/vision/meal")
      .send({ image: atLimit, mediaType: "image/jpeg" })
      .expect(200);
    const over = Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1).toString("base64");
    expect(over.endsWith("=") && !over.endsWith("==")).toBe(true);
    const res = await agent
      .post("/api/vision/meal")
      .send({ image: over, mediaType: "image/jpeg" })
      .expect(413);
    expect(res.body.error).toBe("image_too_large");
    expect(client.beta.messages.parse).toHaveBeenCalledTimes(1);
  });

  // Value: protects=bad input, an oversize photo and a deployment without the key are refused before a
  //   photo is counted, and the route needs a member session; fails_when=validation runs after the
  //   reservation or a missing key 500s; why_new=new route; seam=setVisionClientForTests(null);
  //   no_claim=the 1 MB body limit itself (app.ts)
  it("refuses bad input, oversize photos and a missing key without counting", async () => {
    await request(app).post("/api/vision/meal").send(PHOTO).expect(401);
    const { agent, user } = await member("careful");
    const { client } = fakeClient(ok([]));

    await agent
      .post("/api/vision/meal")
      .send({ image: "data:image/jpeg;base64,AAAA", mediaType: "image/jpeg" })
      .expect(400);
    await agent
      .post("/api/vision/meal")
      .send({ ...PHOTO, mediaType: "image/gif" })
      .expect(400);
    await agent
      .post("/api/vision/meal")
      .send({ ...PHOTO, extra: 1 })
      .expect(400);
    const big = { image: "A".repeat(940_000), mediaType: "image/jpeg" }; // about 705 KB decoded
    expect((await agent.post("/api/vision/meal").send(big).expect(413)).body.error).toBe(
      "image_too_large",
    );

    setVisionClientForTests(null);
    expect((await agent.post("/api/vision/meal").send(PHOTO).expect(503)).body.error).toBe(
      "vision_unavailable",
    );
    expect(client.beta.messages.parse).not.toHaveBeenCalled();
    expect(await usage(user._id)).toEqual({ count: 0 }); // the schema default: no photo counted
  });
});

describe("visionClient", () => {
  // Value: protects=the real client is built with the 60 s timeout and no SDK retries (the member's
  //   "Try again" is the only retry), and no key means no client; fails_when=the SDK default 10 min
  //   timeout or 2 retries come back; why_new=amendment R3-17; seam=none; no_claim=network behaviour
  it("uses a 60 s timeout, no retries, and needs ANTHROPIC_API_KEY", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(visionClient()).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-placeholder");
    const client = visionClient() as Anthropic;
    expect(client).toBeInstanceOf(Anthropic);
    expect(client.timeout).toBe(VISION_TIMEOUT_MS);
    expect(VISION_TIMEOUT_MS).toBe(60_000);
    expect(client.maxRetries).toBe(0);
    vi.unstubAllEnvs();
  });
});

describe("reservePhoto", () => {
  // Value: protects=parallel first photos of a new day each count once: a request that loses the
  //   "first photo today" write falls back to the increment instead of failing as if over the limit;
  //   fails_when=the retry after the lost race is dropped (members see 429 at 1 of 20); why_new=atomic
  //   counter (design doc C5); seam=none; no_claim=a sharded database
  it("counts parallel first photos of a new day once each", async () => {
    const { user } = await member("racer");
    await MemberProfile.updateOne(
      { userId: user._id },
      { $set: { visionUsage: { date: "2026-11-15", count: 20 } } },
    );
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => reservePhoto(user._id)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 20 });
  });
});

describe("refundPhoto", () => {
  // Generated by /ship coverage audit (T13).
  // Value: protects=a refund for a photo reserved yesterday leaves today's counter alone, and a refund
  //   never takes a counter below 0; fails_when=the refund drops its date or count>0 filter (a call that
  //   fails after local midnight gives the new day a free photo); why_new=no refund test across a day
  //   change; seam=none; no_claim=none beyond protects
  it("leaves a rolled-over day alone and never goes below zero", async () => {
    const { user } = await member("midnight");
    await MemberProfile.updateOne(
      { userId: user._id },
      { $set: { visionUsage: { date: "2026-11-17", count: 3 } } },
    );
    await refundPhoto(user._id, { date: "2026-11-16", count: 20 });
    expect(await usage(user._id)).toEqual({ date: "2026-11-17", count: 3 });

    await MemberProfile.updateOne(
      { userId: user._id },
      { $set: { visionUsage: { date: "2026-11-17", count: 0 } } },
    );
    await refundPhoto(user._id, { date: "2026-11-17", count: 1 });
    expect(await usage(user._id)).toEqual({ date: "2026-11-17", count: 0 });
  });
});

describe("vision review fixes (T13)", () => {
  // Value: protects=an answer the SDK cannot parse (a refusal that came back with text, or output cut
  //   at max_tokens; parse() throws AnthropicError) is a 502 with a "try again" message and is refunded,
  //   not a 500; fails_when=only APIError is mapped; why_new=review p1 (red-team, adversarial);
  //   seam=setVisionClientForTests; no_claim=the SDK's own parser
  it("answers 502 and refunds when the SDK cannot parse the answer", async () => {
    fakeClient(() => {
      throw new Anthropic.AnthropicError("Failed to parse structured output");
    });
    const { agent, user } = await member("garbled");
    const res = await agent.post("/api/vision/meal").send(PHOTO).expect(502);
    expect(res.body).toMatchObject({ error: "vision_failed" });
    expect(typeof res.body.details).toBe("string");
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 0 });
  });

  // Value: protects=editing the time zone cannot reset the day's 20 photos: a zone that moves "today"
  //   back keeps the count, and moving forward again finds the same full day; fails_when=the counter
  //   resets on any different date (unbounded paid calls per member); why_new=review p1 (targeted,
  //   money); seam=none; no_claim=a zone change that really moves the date forward (one extra day)
  it("does not reset the day's photos when the time zone moves the date back", async () => {
    fakeClient(ok([]));
    const { agent, user } = await member("zoner", "Pacific/Kiritimati"); // UTC+14: 2026-11-17
    for (let i = 0; i < 20; i++) await agent.post("/api/vision/meal").send(PHOTO).expect(200);
    await MemberProfile.updateOne({ userId: user._id }, { $set: { timezone: "Etc/GMT+12" } }); // 2026-11-16
    await agent.post("/api/vision/meal").send(PHOTO).expect(429);
    await MemberProfile.updateOne(
      { userId: user._id },
      { $set: { timezone: "Pacific/Kiritimati" } },
    );
    await agent.post("/api/vision/meal").send(PHOTO).expect(429);
    expect(await usage(user._id)).toEqual({ date: "2026-11-17", count: 20 });
  });

  // Value: protects=failed calls are refunded only 10 times a day (Anthropic bills them): the 11th failure
  //   counts, so a member's paid calls per day stay bounded; fails_when=every failure is refunded;
  //   why_new=review p1 (targeted, money); seam=setVisionClientForTests; no_claim=Anthropic's billing
  it("stops refunding after 10 failed calls a day", async () => {
    fakeClient(() => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    const { agent, user } = await member("unlucky");
    for (let i = 0; i < 10; i++) await agent.post("/api/vision/meal").send(PHOTO).expect(504);
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 0 });
    await agent.post("/api/vision/meal").send(PHOTO).expect(504);
    expect(await usage(user._id)).toEqual({ date: "2026-11-16", count: 1 });
  });

  // Value: protects=a member whose profile document is missing is told so (409), not "photo limit
  //   reached" with 0 used; fails_when=a missing profile reads as a full day; why_new=review p1
  //   (red-team); seam=none; no_claim=how the profile went missing
  it("tells a member without a profile document so, not that the day is full", async () => {
    fakeClient(ok([]));
    const { agent, user } = await member("ghost");
    await MemberProfile.deleteOne({ userId: user._id });
    expect((await agent.post("/api/vision/meal").send(PHOTO).expect(409)).body.error).toBe(
      "member_profile_missing",
    );
  });
});
