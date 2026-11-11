// Runs in every API test worker before the test file (vitest setupFiles). One in-memory MongoDB
// per worker; collections are emptied after each test so files cannot leak state into each other.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll } from "vitest";
import { connectDb, disconnectDb } from "../src/lib/db.js";

let mongod: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "healtheat_test";
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-secret";
  await connectDb();
}, 120_000);

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await disconnectDb();
  await mongod?.stop();
});
