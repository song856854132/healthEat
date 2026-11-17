"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "./auth-context";
import { postAuth } from "./lib/api";
import type { FormErrors } from "./lib/api";

/** Client-side check of the form: the request body, or the errors to show without calling the API. */
export type Validate = (
  data: FormData,
) => { ok: true; body: unknown } | { ok: false; errors: FormErrors };

/**
 * Given the body the server rejected and the paths its validation_error named, a corrected body to
 * send once more, or undefined to show the errors as they are.
 */
export type Retry = (body: unknown, invalidPaths: readonly string[]) => unknown;

/**
 * Shared flow of /login and /register: validate, POST, store the returned account, and leave the
 * page once signed in. `fields` are the inputs the page renders (server errors for anything else
 * become the form-level message).
 */
export function useAuthForm(
  path: "/api/auth/register" | "/api/auth/login",
  fields: readonly string[],
  validate: Validate,
  retry?: Retry,
) {
  const { recheck, setMe } = useAuth();
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [pending, setPending] = useState(false);
  // Synchronous guard: two submits in the same tick both see the old `pending` state.
  const busy = useRef(false);

  // Already signed in: these pages have nothing to offer. Ask the server rather than trusting the
  // nav's copy, which may be from before the session ended in another tab.
  useEffect(() => {
    let live = true;
    void recheck().then((session) => {
      if (live && session) router.replace("/");
    });
    return () => {
      live = false;
    };
  }, [recheck, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy.current) return;
    const checked = validate(new FormData(e.currentTarget));
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    busy.current = true;
    setPending(true);
    setErrors({ fields: {} });
    let result = await postAuth(path, checked.body, fields);
    if (!result.ok && retry) {
      const again = retry(checked.body, result.invalidPaths);
      if (again !== undefined) result = await postAuth(path, again, fields);
    }
    if (result.ok) {
      // Stay pending until the redirect leaves the page: a second submit would re-register (409) or
      // send a second login.
      setMe(result.me);
      router.replace("/");
      return;
    }
    setErrors(result.errors);
    busy.current = false;
    setPending(false);
  }

  return { errors, pending, onSubmit };
}

export function FormAlert({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="form-error">
      {message}
    </p>
  ) : null;
}
