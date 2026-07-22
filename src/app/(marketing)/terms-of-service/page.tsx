import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of the Dropscale IO website and client portal.",
};

export default function TermsOfServicePage() {
  return (
    <LegalPage title="Terms of Service" updated="22 July 2026">
      <LegalSection title="1. The service">
        <p>
          Dropscale IO (&quot;Dropscale&quot;, &quot;we&quot;) provides Google Ads management
          services and a client portal at <a href="https://dropscale.app">dropscale.app</a> where
          clients can view campaign performance, manage connected ad accounts and communicate with
          the team. The specific scope, fees and targets of each engagement are agreed separately in
          a proposal or services agreement; these Terms govern the use of the website and portal.
        </p>
      </LegalSection>

      <LegalSection title="2. Accounts">
        <p>
          You must provide accurate information when creating an account and keep your credentials
          confidential. Accounts are activated after review by our team. You are responsible for
          activity under your account; tell us immediately at{" "}
          <a href="mailto:leandro@dropscale.io">leandro@dropscale.io</a> if you suspect unauthorised use.
        </p>
      </LegalSection>

      <LegalSection title="3. Connecting Google Ads accounts">
        <p>
          By connecting a Google Ads account you confirm you are authorised to grant access to it.
          Access is read-only, is used solely to provide the service, and can be revoked by you at
          any time (see our <a href="/privacy-policy">Privacy Policy</a>). You remain the owner of
          your Google Ads accounts and of all data in them at all times.
        </p>
      </LegalSection>

      <LegalSection title="4. Your responsibilities">
        <ul className="space-y-2">
          <li>Use the portal lawfully and only for its intended purpose.</li>
          <li>Do not attempt to access other clients&apos; data or probe the service&apos;s security.</li>
          <li>Keep the products and landing pages you advertise compliant with Google&apos;s policies.</li>
          <li>Pay agreed fees on time, as set out in your proposal or services agreement.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Intellectual property">
        <p>
          The portal, website, and all their code, design and content are the property of Dropscale
          IO. Campaign assets we produce for you are licensed to you for use in your accounts;
          your trademarks, products and data remain yours. Nothing in these Terms transfers either
          party&apos;s pre-existing intellectual property to the other.
        </p>
      </LegalSection>

      <LegalSection title="6. Performance and disclaimers">
        <p>
          Advertising performance depends on factors outside any agency&apos;s control — auction
          dynamics, market conditions, your website and offer. We commit to diligent, professional
          management; we do not guarantee specific revenue, ROAS or lead outcomes. The portal and
          website are provided &quot;as is&quot;, and dashboard figures may occasionally lag or
          differ slightly from Google&apos;s own reporting.
        </p>
      </LegalSection>

      <LegalSection title="7. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Dropscale IO is not liable for indirect or
          consequential losses (including lost profits or lost data), and our total aggregate
          liability arising from the service is limited to the fees you paid us in the three months
          preceding the event giving rise to the claim. Nothing limits liability that cannot be
          limited by law.
        </p>
      </LegalSection>

      <LegalSection title="8. Suspension and termination">
        <p>
          You may stop using the portal and disconnect your accounts at any time; engagement
          termination terms are in your services agreement. We may suspend or terminate portal
          access for breach of these Terms, unlawful use, or risk to the service or other clients.
          Upon termination we delete your stored Google OAuth tokens and, on request, your account
          data.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes">
        <p>
          We may update these Terms as the service evolves. Material changes will be announced in
          the portal; continued use after a change means acceptance. The date above always reflects
          the latest revision.
        </p>
      </LegalSection>

      <LegalSection title="10. Governing law">
        <p>
          These Terms are governed by the laws of Portugal, and any dispute not resolved amicably is
          subject to the courts of Portugal. Mandatory consumer protections of your country of
          residence, where applicable, are unaffected.
        </p>
      </LegalSection>

      <LegalSection title="11. Contact">
        <p>
          Questions about these Terms: <a href="mailto:leandro@dropscale.io">leandro@dropscale.io</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
