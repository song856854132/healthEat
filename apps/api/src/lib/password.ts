import bcrypt from "bcryptjs";

// Design doc: bcrypt, cost 12. bcryptjs (pure JavaScript) instead of the native `bcrypt` module: CI
// builds the Vercel bundle on x86_64 while developer machines differ, and a prebuilt native module
// uploaded for the wrong architecture fails only at the first request. ~250 ms per hash on a function.
export const BCRYPT_COST = 12;

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, BCRYPT_COST);

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);

// Compared against when the username is unknown, so a login with a bad username costs the same
// bcrypt work as one with a bad password (no timing oracle on account existence). Cost 12.
export const DUMMY_HASH = "$2b$12$1QSQAUQhEqOqFC.MxaZJdOSVCa94RmvjnEOs4J2K2QFBXN8KiGOPO";
