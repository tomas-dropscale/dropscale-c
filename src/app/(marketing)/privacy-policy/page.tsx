import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Dropscale IO collects, uses and protects your data, including Google Ads data accessed via OAuth.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="22 July 2026">
      <LegalSection title="1. Who we are">
        <p>
          Dropscale IO (&quot;Dropscale&quot;, &quot;we&quot;, &quot;us&quot;) is a Google Ads
          management agency operating the website and client portal at{" "}
          <a href="https://dropscale.app">dropscale.app</a>. For any privacy question or request,
          contact us at <a href="mailto:leandro@dropscale.io">leandro@dropscale.io</a>.
        </p>
      </LegalSection>

      <LegalSection title="2. Data we collect">
        <ul className="space-y-2">
          <li>
            <strong>Account data</strong> — your name, email address and password (stored hashed by
            our authentication provider) when you create a portal account, and your avatar if you
            sign in with Google.
          </li>
          <li>
            <strong>Google Ads data via OAuth</strong> — if you connect a Google Ads account to the
            portal, we receive an OAuth token authorising read access to that account and use it to
            retrieve campaign data: campaign names and status, spend, impressions, clicks,
            conversions and related performance metrics, plus your Google Ads customer ID and the
            email of the Google account you connected with.
          </li>
          <li>
            <strong>Billing profile</strong> — company or personal billing details you choose to
            enter in the portal.
          </li>
          <li>
            <strong>Service requests</strong> — the content of account requests you submit (for
            example a store name or a Shopify URL).
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="3. How we use your data">
        <ul className="space-y-2">
          <li>To operate the client portal: authentication, showing you your own campaign data.</li>
          <li>To provide the agency service: managing and reporting on your Google Ads accounts.</li>
          <li>To communicate with you: account emails (confirmation, password reset) and support.</li>
          <li>To secure the service: fraud prevention and access control.</li>
        </ul>
        <p>We do not sell personal data, and we do not use your data for third-party advertising.</p>
      </LegalSection>

      <LegalSection title="4. Google user data and Limited Use">
        <p>
          Google Ads data is accessed only after you explicitly authorise it through Google&apos;s
          consent screen, and only with read scope. Your OAuth refresh token is stored{" "}
          <strong>encrypted (AES-256)</strong>; the decryption key is held only on our servers and
          the token is never exposed to your browser or to other users. You can revoke access at any
          time — by disconnecting the account inside the portal, or from your{" "}
          <a href="https://myaccount.google.com/permissions">Google Account permissions page</a>.
          Disconnecting deletes the stored token.
        </p>
        <p>
          Dropscale IO&apos;s use and transfer of information received from Google APIs adheres to
          the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </LegalSection>

      <LegalSection title="5. Who we share data with">
        <p>
          We share data only with the processors needed to run the service, under their own data
          protection terms:
        </p>
        <ul className="space-y-2">
          <li>
            <strong>Supabase</strong> — authentication and database hosting.
          </li>
          <li>
            <strong>Cloudflare</strong> — application hosting and content delivery.
          </li>
          <li>
            <strong>Google APIs</strong> — to retrieve the Google Ads data you authorised.
          </li>
          <li>
            <strong>Resend</strong> — transactional email delivery (confirmation and reset emails).
          </li>
        </ul>
        <p>
          We may also disclose data where required by law. We never sell it or share it for
          marketing purposes.
        </p>
      </LegalSection>

      <LegalSection title="6. Retention and deletion">
        <p>
          Account data is kept while your account is active. If your access is revoked or you ask us
          to delete your account, we delete your portal data; encrypted Google OAuth tokens are
          deleted immediately upon disconnection or account deletion. Backups expire on a rolling
          schedule.
        </p>
      </LegalSection>

      <LegalSection title="7. Your rights">
        <p>
          Under the GDPR you may request access to, correction of, export of, or deletion of your
          personal data, and you may object to or restrict certain processing. Write to{" "}
          <a href="mailto:leandro@dropscale.io">leandro@dropscale.io</a> and we will respond within 30
          days. You also have the right to lodge a complaint with your local supervisory authority
          (in Portugal, the CNPD).
        </p>
      </LegalSection>

      <LegalSection title="8. Cookies">
        <p>
          The portal uses <strong>essential cookies only</strong>: an authentication session cookie
          and a language preference. We do not use advertising or cross-site tracking cookies on
          this website.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to this policy">
        <p>
          We may update this policy as the service evolves. Material changes will be announced in
          the portal, and the date at the top always reflects the latest revision.
        </p>
      </LegalSection>

      <LegalSection title="10. Contact">
        <p>
          Privacy questions and requests: <a href="mailto:leandro@dropscale.io">leandro@dropscale.io</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
