"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "./auth-context";
import { postAuth } from "./lib/api";
import type { FormErrors } from "./lib/api";

/** Client-side check of the form: the request body, or the errors to show without calling the API. */
export type Validate = (
  data: FormData,
) => { ok: true; body: unknown } | { ok: false; errors: FormErrors };

/**
 * Shared flow of /login and /register: validate, POST, store the returned account, and leave the
 * page once signed in. `fields` are the inputs the page renders (server errors for anything else
 * become the form-level message).
 */
export function useAuthForm(
  path: "/api/auth/register" | "/api/auth/login",
  fields: readonly string[],
  validate: Validate,
) {
  const { me, setMe } = useAuth();
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [pending, setPending] = useState(false);

  // Already signed in (or just signed in here): these pages have nothing to offer.
  useEffect(() => {
    if (me) router.replace("/");
  }, [me, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const checked = validate(new FormData(e.currentTarget));
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setPending(true);
    setErrors({ fields: {} });
    try {
      const result = await postAuth(path, checked.body, fields);
      if (result.ok) setMe(result.me);
      else setErrors(result.errors);
    } finally {
      setPending(false);
    }
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
