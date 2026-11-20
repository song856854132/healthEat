import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME, PRIVACY_ACK_COOKIE, SESSION_COOKIE } from "@healtheat/shared";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: `Privacy policy · ${APP_NAME}`,
  description: `What ${APP_NAME} stores, who can see it, which cookies it sets and how to delete your account.`,
};

// Bump when the text changes in substance. The policy describes the app as built: each statement
// matches the code it names (apps/api models, lib/session.ts, routes/auth.ts, services/account.ts),
// and e2e/privacy-about.spec.ts checks that every cookie the site sets is listed here.
const UPDATED = "November 20, 2026";
const UPDATED_ISO = "2026-11-20";

/**
 * /privacy (design doc, Pages table; "Privacy policy on first visit" and "Privacy policy must
 * disclose"). Public for every role, static, no session needed.
 */
export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <h1>Privacy policy</h1>
      <p className={styles.updated}>
        Last updated <time dateTime={UPDATED_ISO}>{UPDATED}</time>
      </p>

      <p className={styles.summary}>
        <strong>In short:</strong> {APP_NAME} stores what you log so it can show your week. No other
        account can read your logs. Meal photos are analysed by Anthropic and not stored by{" "}
        {APP_NAME}. Food searches go to USDA FoodData Central. There are two cookies, both needed to
        run the site, and no analytics or advertising. You can delete your account and everything in
        it.
      </p>

      <p>
        {APP_NAME} is a course final project, not a medical service. Allergen detection is an
        estimate from ingredient lists and food names; always check the package label.
      </p>

      <h2 id="what-we-store">What we store</h2>
      <ul>
        <li>
          <strong>Your account:</strong> username, email address, a hash of your password (bcrypt;
          the password itself is never stored), your roles (Member, and Curator or Admin if
          granted), account status, the dates the account was created and last changed, and when you
          acknowledged this policy.
        </li>
        <li>
          <strong>Your member profile:</strong> your time zone (taken from your browser when you
          register), and the details you choose to add: sex, birth year, height, weight, activity
          level, calorie band, phone number, and your sharing choices (all off by default). It also
          counts how many meal photos you analysed today, to apply the daily photo limit.
        </li>
        <li>
          <strong>Your food log:</strong> for each entry, the date, the meal, the food, the amount
          in grams, and whether it came from a search or a photo (with the recognition&apos;s
          confidence for photo entries).
        </li>
        <li>
          <strong>Your allergen settings:</strong> the allergens and sensitivities you track or
          avoid.
        </li>
        <li>
          <strong>Curators and Admins:</strong> the profile you fill in (for Curators: credentials,
          bio, specialties), and counts of the dictionary edits or account changes you made.
        </li>
        <li>
          <strong>Sign-in protection:</strong> when you try to log in, a counter keyed by the
          username and the connecting IP address. A successful login clears it; otherwise it is
          deleted 15 minutes after it started. It is how logins are paused after 10 wrong passwords.
        </li>
        <li>
          <strong>Your session:</strong> a record that you are signed in, kept for 14 days after you
          last used the site, or until you log out.
        </li>
      </ul>
      <p>
        We do not store meal photos. Food searches are cached for 24 hours so repeated searches do
        not call USDA again, and opened foods are kept so log entries can point at them; neither
        cache records who searched or opened a food.
      </p>

      <h2 id="who-can-see-it">Who can see it</h2>
      <ul>
        <li>
          <strong>Other members and visitors</strong> cannot read your logs, bands, symptoms,
          allergen settings, email or body measurements. Your username is public, because profile
          pages and links use it; your profile page also shows when you joined and your Member or
          Curator role. If you turn on public logs, your username appears next to foods you logged
          (to signed-in viewers), and your username, a Member badge and your join date can be listed
          among the newest members on the Home page, visible without signing in. Your phone number
          is shown only if you turn that on. Counts across all members (such as how often a food was
          logged this week) can appear on public pages without usernames.
        </li>
        <li>
          <strong>Curators</strong> maintain the allergen dictionary. They see dictionary data and
          aggregate match counts, never anyone&apos;s logs. A Curator&apos;s credentials, bio and
          specialties are public on their profile page, and a Curator who opts in to the listing
          appears on the Home page with a Curator badge.
        </li>
        <li>
          <strong>Admins</strong> manage accounts. They see account fields only: username, email,
          roles, status, the active role, dates (created, policy acknowledged) and whether a
          deletion is in progress. They can suspend an account or delete it, with the same deletion
          as below. They cannot read your logs or profile details.
        </li>
      </ul>

      <h2 id="third-parties">Services we send data to</h2>
      <ul>
        <li>
          <strong>USDA FoodData Central</strong> receives your food searches and the ids of foods
          you open. Our server makes these requests, so USDA sees our server, not your browser or
          your account.
        </li>
        <li>
          <strong>Anthropic</strong> receives a meal photo when you use photo logging, to recognise
          the foods in it. The photo is sent for that one request and is not stored by {APP_NAME};
          only the entries you confirm are saved. Anthropic&apos;s handling is covered by{" "}
          <a href="https://www.anthropic.com/legal/privacy">its privacy policy</a>.
        </li>
        <li>
          <strong>Hosting:</strong> the site and its API run on Vercel, and the database is MongoDB
          Atlas. They process the data above on our behalf, and the hosts keep short-lived request
          and error logs.
        </li>
      </ul>
      <p>We do not sell data, show advertising, or use analytics or tracking scripts.</p>

      <h2 id="cookies">Cookies</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Cookie</th>
              <th scope="col">Why</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                <code>{SESSION_COOKIE}</code>
              </th>
              <td>
                Keeps you signed in. Set when you register or log in. Page scripts cannot read it
                (HttpOnly), and on the live site it is sent only over HTTPS.
              </td>
              <td>14 days, renewed as you use the site; removed when you log out</td>
            </tr>
            <tr>
              <th scope="row">
                <code>{PRIVACY_ACK_COOKIE}</code>
              </th>
              <td>
                Remembers that you have seen the privacy notice, so the banner stops showing. When
                you register or log in, the acknowledgment is also saved on your account, so it
                follows you to new devices.
              </td>
              <td>1 year</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Both cookies are first-party and needed for the site to work. The only other cookie is{" "}
        <code>he_spike</code>, set only if you press &quot;Set cookie&quot; in the connection check
        on the Home page; it holds a fixed test name, nothing about you, and expires after an hour
        or when you press &quot;Clear cookie&quot;.
      </p>

      <h2 id="delete">Deleting your account</h2>
      <p>
        Deleting your account removes your account, all your profiles, every food log entry, your
        allergen settings and your sessions, and later your symptom entries once symptom logging
        exists. It takes effect at once: you are signed out and cannot log in again, and it cannot
        be undone. Aggregate counts that never contained your username are not affected. If you were
        a Curator, the dictionary entries you edited keep an internal id of the editor (not your
        username), and the Home page&apos;s stored list drops your username at its next refresh,
        within minutes.
      </p>
      <p>
        While signed in, delete it with a <code>DELETE</code> request to <code>/api/users/me</code>.
        A Delete account button on your profile page is being added. If you are the only Admin, the
        deletion is refused until another Admin exists, so the site always keeps one.
      </p>

      <h2 id="changes">Changes and questions</h2>
      <p>
        If this policy changes, the date at the top changes too. Questions or requests:{" "}
        <a href="https://github.com/song856854132/healthEat/issues">
          open an issue on the project&apos;s repository
        </a>
        .
      </p>

      <p className={styles.related}>
        <Link href="/about">About {APP_NAME} and its data sources</Link> ·{" "}
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
