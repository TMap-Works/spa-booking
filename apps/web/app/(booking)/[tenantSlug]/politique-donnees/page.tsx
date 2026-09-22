import type { PublicTenant } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { SalonShell } from '@/components/salon/salon-shell';
import { readAccountPresence } from '@/lib/account-presence';
import { ApiClientError } from '@/lib/api-client';
import { consentCopy, type ConsentVariant } from '@/lib/booking/consent';

import { BookingErrorNotice } from '../booking-error-notice';
import { accountPath, loadSalonTenant, reservationPath, salonPath, siteOrigin } from '../salon-data';

/**
 * La politique de données d'un établissement — quatrième critère de #790.
 *
 * ## Ce qu'elle répare
 *
 * `docs/design/appointments/wireframes.md`, étape 4, dessine « J'accepte les CGV
 * et **la politique de données** ». #734 a rendu les finalités en place, dans un
 * dépliant, faute de page à lier — et l'a écrit noir sur blanc dans l'en-tête de
 * `lib/booking/consent.tsx` : « un lien vers une page inexistante informe moins
 * que pas de lien du tout ». La page existe maintenant, et les deux blocs de
 * consentement la lient.
 *
 * Le dépliant n'a pas disparu pour autant, et ce n'est pas un doublon : il reste
 * ce qui se lit **sans cliquer**, c'est-à-dire le seul texte que la cliente est
 * sûre d'avoir eu sous les yeux au moment de cocher. Cette page-ci est le texte
 * complet, pour qui le veut — RGPD art. 12 demande une information « aisément
 * accessible », pas une information à deux endroits différents qui se
 * contrediraient.
 *
 * ## Elle se **dérive** des deux blocs, elle ne les recopie pas
 *
 * `consentCopy(t, 'booking' | 'account')` rend exactement ce que les deux écrans
 * affichent, dans la langue du visiteur (#846) : la page lit la même source
 * qu'eux plutôt que d'en recopier le texte. Une seconde rédaction des mêmes
 * finalités aurait divergé de la première au premier changement de texte, et
 * c'est précisément le défaut que l'en-tête de `consent.tsx` dit vouloir éviter
 * en n'écrivant les finalités qu'une fois. Ce que cette page ajoute, elle
 * l'ajoute : le responsable du traitement, la base légale, la preuve conservée,
 * les sous-traitants, et rien qui soit déjà dit ailleurs.
 *
 * ## Server Component, et `(booking)` plutôt que `(account)`
 *
 * La page est **publique** : elle doit se lire sans compte, depuis le tunnel
 * comme depuis l'inscription, et se laisser indexer. Elle n'a aucun état, aucun
 * formulaire, aucun `use client` — comme la vitrine voisine, et pour les mêmes
 * raisons (skill web-frontend §1).
 *
 * Elle est posée sous `[tenantSlug]/` et non sous `reservation/` : le layout du
 * tunnel y poserait le bandeau « Prendre rendez-vous » et un second `<h1>`, sur
 * une page qui n'est pas une étape de réservation. Elle porte donc son propre
 * conteneur `.spa-salon`, celui de la vitrine.
 *
 * ## `force-dynamic`
 *
 * Même raison que ses deux voisines : le nom de l'établissement change sans que
 * le front en soit averti, et un prérendu au build appellerait l'API depuis le
 * runner de CI ou l'étape `build` de l'image Docker, où elle n'existe pas.
 *
 * ## La langue (#846)
 *
 * C'est un texte **juridique** : il est traduit, jamais réécrit. Chaque section
 * garde sa clé, chaque paragraphe la sienne, et la structure du document est
 * celle du français — un titre de section fondu dans son paragraphe, ou deux
 * paragraphes réunis en un, feraient de la version anglaise une autre
 * information que celle due à la personne concernée (CDC §5.1, RGPD art. 12 et
 * 13). Les mots du droit sont ceux du CDC anglais : *data controller*,
 * *processor*, *data-subject rights*, *access, rectification, export and
 * deletion*.
 *
 * Ce que l'**établissement** a saisi — son nom — traverse en paramètre et ne se
 * traduit pas (`{salonName}`) : c'est son identité, pas un libellé d'interface.
 *
 * Les finalités, elles, ne sont toujours pas écrites ici : la page les **dérive**
 * de `lib/booking/consent.tsx`, et c'est ce module qui porte leur traduction.
 * En écrire une seconde version sous la racine `dataPolicy` aurait recréé
 * exactement la divergence que l'en-tête ci-dessus dit vouloir éviter — en
 * anglais cette fois, donc deux fois moins relue.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenantSlug } = await params;
  // `generateMetadata` est asynchrone : `getTranslations` et non le crochet.
  const t = await getTranslations('booking');

  try {
    const tenant = await loadSalonTenant(tenantSlug);
    const title = t('dataPolicy.metadata.title', { salonName: tenant.name });
    const description = t('dataPolicy.metadata.description', { salonName: tenant.name });

    return {
      metadataBase: new URL(siteOrigin()),
      title,
      description,
      alternates: { canonical: `${salonPath(tenant.slug)}/politique-donnees` },
      // Indexable, et c'est le propos : une information qu'on ne trouve pas
      // n'est pas « aisément accessible » (RGPD art. 12). C'est aussi la page
      // qu'un visiteur cherche avant de confier quoi que ce soit.
      robots: { index: true, follow: true },
    };
  } catch (error) {
    // Même conduite que la vitrine : `generateMetadata` ne doit pas jeter, et le
    // `noindex` est réservé au 404 — une panne d'API n'est pas une consigne. Le
    // titre de repli est celui de la page sans son établissement : le nom du
    // salon est précisément ce qu'on n'a pas pu lire.
    const fallbackTitle = t('dataPolicy.metadata.fallbackTitle');

    if (error instanceof ApiClientError && error.status === 404) {
      return { title: fallbackTitle, robots: { index: false, follow: false } };
    }

    return { title: fallbackTitle };
  }
}

/**
 * Une section « à quoi servent vos données », rendue depuis le bloc de
 * consentement de l'écran correspondant.
 *
 * Le libellé de la case (`copy.label`) est repris tel quel : c'est le texte
 * exact que la cliente accepte, et le lire ici sous une autre formulation
 * laisserait croire qu'elle a consenti à autre chose. Cela vaut aussi d'une
 * langue à l'autre (#846) — ce qui est repris est le libellé **tel que l'écran
 * l'affiche à ce visiteur-là**, donc déjà dans sa langue, et non une seconde
 * traduction faite ici qui pourrait en dévier d'un mot.
 *
 * Composant synchrone : `useTranslations` y fonctionne, là où la page qui
 * l'appelle est asynchrone et lit ses messages par `getTranslations`.
 */
function PurposeSection({
  variant,
  title,
  headingId,
}: {
  readonly variant: ConsentVariant;
  readonly title: string;
  readonly headingId: string;
}) {
  const t = useTranslations('booking');
  // La copie est **lue**, pas reçue : c'est ce qui garantit qu'elle est la même
  // chaîne que celle du formulaire, dans la même langue, et non une seconde
  // rédaction (#846). `consentCopy` est la source unique des deux écrans.
  const copy = consentCopy(t, variant);

  return (
    <section className="spa-salon__section" aria-labelledby={headingId}>
      <h2 className="spa-salon__section-title" id={headingId}>
        {title}
      </h2>
      <p>{copy.intro}</p>
      <ul className="spa-list">
        {copy.purposes.map((purpose) => (
          <li key={purpose.data}>
            <strong>{purpose.data}</strong> — {purpose.why}
          </li>
        ))}
      </ul>
      {/* Les guillemets font partie du message : le français cite entre « … »
          et l'anglais entre “ … ”, et les laisser en JSX aurait figé les
          premiers dans les deux langues. */}
      <p>
        {t.rich('dataPolicy.purposes.checkboxWording', {
          label: copy.label,
          quote: (chunks) => <em>{chunks}</em>,
        })}
      </p>
    </section>
  );
}

export default async function DataPolicyPage({ params }: PageProps) {
  const { tenantSlug } = await params;
  // Composant asynchrone : `getTranslations` et non le crochet (#846).
  const t = await getTranslations('booking');

  // Le gabarit du salon (#1045) : même en-tête et même pied que la vitrine.
  const presence = await readAccountPresence();
  const shell = (tenant: PublicTenant | null, content: ReactNode) => (
    <SalonShell
      tenantSlug={tenantSlug}
      tenant={tenant}
      signedIn={presence !== null}
      presence={presence}
      bookingHref={reservationPath(tenantSlug)}
    >
      {content}
    </SalonShell>
  );

  let tenant: PublicTenant;

  try {
    tenant = await loadSalonTenant(tenantSlug);
  } catch (error) {
    // Établissement inconnu, désactivé, ou slug mal formé : l'API répond 404 sans
    // distinguer les trois, et c'est voulu — un 403 confirmerait l'existence de
    // l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    // La panne ne prive pas de la sortie : le slug de l'URL suffit à adresser
    // l'espace client depuis l'en-tête, comme sur la vitrine.
    return shell(
      null,
      <div className="spa-salon">
        <main className="spa-salon__main" id="contenu">
          <BookingErrorNotice title={t('dataPolicy.loadError')} error={error} />
        </main>
      </div>,
    );
  }

  const tenantName = tenant.name;
  /**
   * Les deux balises que la prose de cette page porte, fournies une fois.
   *
   * `t.rich` et non une découpe du message en trois clés : une phrase coupée en
   * « avant », « le mot en gras » et « après » n'est plus traduisible — l'ordre
   * des mots change d'une langue à l'autre, et le traducteur ne voit jamais la
   * phrase entière.
   */
  const marks = {
    strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
    salon: (chunks: ReactNode) => <strong>{chunks}</strong>,
  };

  return shell(
    tenant,
    <div className="spa-salon">
      <main className="spa-salon__main" id="contenu">
        <header className="spa-salon__header">
          <p className="spa-salon__eyebrow">{tenantName}</p>
          <h1 className="spa-salon__title">{t('dataPolicy.heading.title')}</h1>
          <p className="spa-salon__lede">
            {t('dataPolicy.heading.lede', { salonName: tenantName })}
          </p>
        </header>

        <section className="spa-salon__section" aria-labelledby="responsable">
          <h2 className="spa-salon__section-title" id="responsable">
            {t('dataPolicy.controller.title')}
          </h2>
          <p>{t.rich('dataPolicy.controller.body', { ...marks, salonName: tenantName })}</p>
          <p>{t('dataPolicy.controller.isolation')}</p>
        </section>

        <PurposeSection
          variant="booking"
          title={t('dataPolicy.purposes.bookingTitle')}
          headingId="reservation"
        />

        <PurposeSection
          variant="account"
          title={t('dataPolicy.purposes.accountTitle')}
          headingId="compte"
        />

        <section className="spa-salon__section" aria-labelledby="base-legale">
          <h2 className="spa-salon__section-title" id="base-legale">
            {t('dataPolicy.legalBasis.title')}
          </h2>
          <p>{t('dataPolicy.legalBasis.blocking')}</p>
          <p>{t.rich('dataPolicy.legalBasis.proof', marks)}</p>
          <p>{t('dataPolicy.legalBasis.serverClock')}</p>
          <p>{t('dataPolicy.legalBasis.serviceMessages')}</p>
        </section>

        <section className="spa-salon__section" aria-labelledby="destinataires">
          <h2 className="spa-salon__section-title" id="destinataires">
            {t('dataPolicy.recipients.title')}
          </h2>
          <ul className="spa-list">
            <li>{t.rich('dataPolicy.recipients.team', marks)}</li>
            <li>{t.rich('dataPolicy.recipients.senders', marks)}</li>
            <li>{t.rich('dataPolicy.recipients.paymentProvider', marks)}</li>
          </ul>
          <p>{t('dataPolicy.recipients.noSale')}</p>
        </section>

        <section className="spa-salon__section" aria-labelledby="conservation">
          <h2 className="spa-salon__section-title" id="conservation">
            {t('dataPolicy.retention.title')}
          </h2>
          {/* La phrase des droits est celle du bloc de consentement, lue dans
              la même source (#846) : les deux variantes la partagent. */}
          <p>{consentCopy(t, 'booking').rights}</p>
          <p>{t.rich('dataPolicy.retention.anonymisation', marks)}</p>
          <p>
            {t.rich('dataPolicy.retention.selfService', {
              account: (chunks) => (
                <Link href={`${accountPath(tenantSlug)}/coordonnees`}>{chunks}</Link>
              ),
            })}
          </p>
        </section>

        <section className="spa-salon__section" aria-labelledby="retour">
          <h2 className="spa-salon__section-title" id="retour">
            {t('dataPolicy.backToSalon.title')}
          </h2>
          <ul className="spa-list">
            <li>
              <Link href={salonPath(tenantSlug)}>
                {t('dataPolicy.backToSalon.services', { salonName: tenantName })}
              </Link>
            </li>
            <li>
              <Link href={reservationPath(tenantSlug)}>{t('dataPolicy.backToSalon.booking')}</Link>
            </li>
            <li>
              <Link href={accountPath(tenantSlug)}>{t('dataPolicy.backToSalon.account')}</Link>
            </li>
          </ul>
        </section>
      </main>
    </div>,
  );
}
