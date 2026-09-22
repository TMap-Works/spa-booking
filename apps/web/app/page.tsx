import { SUBSCRIPTION_PLAN, type Locale } from '@spa/shared';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import Image from 'next/image';
import Link from 'next/link';

import { BookingPreview } from '@/components/home/booking-preview';
import { SalonFinder } from '@/components/home/salon-finder';
import { publicExitLabels } from '@/components/salon/public-exits';
import { Icon, type IconName } from '@/components/ui/icon';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { formatMoneyCompact, type DisplayLocale } from '@/lib/format';
import { PHOTOS, type Photo } from '@/lib/photos';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';
import { readSalonIdentity } from '@/lib/salon-identity';

import { salonPath } from './(account)/[tenantSlug]/compte/paths';
import { readLastSalon } from './last-salon';
import { SALON_DOORS, salonDoorPath, type SalonDoor } from './salon-doors';

/**
 * La page d'accueil de la plateforme — la racine du domaine (#927).
 *
 * ## Ce qu'elle remplace
 *
 * Un paragraphe : « chaque salon a sa propre page de réservation, suivez le lien
 * qu'il vous a communiqué ». Juste, mais sans issue — pour ouvrir quoi que ce
 * soit, il fallait taper une URL de la forme `/nom-du-salon/…`, y compris pour
 * l'équipe d'un salon qui cherchait son back-office.
 *
 * ## Ce qu'elle fait, et ce qu'elle s'interdit
 *
 * Elle présente le produit à ses deux publics — la clientèle qui réserve et
 * l'équipe qui accueille — par la boucle de valeur du CDC (§1.2) : réserver,
 * confirmer, honorer, encaisser, mesurer. Puis elle **ouvre le salon** qu'on lui
 * désigne, par la porte qu'on choisit (`SalonFinder`).
 *
 * Elle ne liste aucun salon — un annuaire est une place de marché, hors
 * périmètre (CDC §1.4). Depuis l'ADR 0016, elle propose en revanche **l'offre**
 * de la plateforme et l'inscription d'un salon en libre-service
 * (`/inscription`) : un essai gratuit, puis un abonnement mensuel. Chaque
 * promesse écrite ci-dessous correspond à une fonctionnalité livrée, et à rien
 * de plus.
 *
 * ## Le salon de la dernière visite
 *
 * Quand la personne a déjà ouvert un salon d'ici, un cookie en garde le slug
 * (`last-salon.ts`) et l'accueil lui en redonne les trois portes sans rien
 * ressaisir. Le nom est relu à l'API à chaque rendu ; si elle ne répond pas, le
 * raccourci s'efface et le slug préremplit simplement le champ — la page ne
 * dépend jamais de cet appel pour s'afficher.
 *
 * ## Server Component
 *
 * Tout ici est du contenu. Seul le formulaire est un Client Component, pour
 * garder la saisie et afficher son erreur sur le champ.
 *
 * ## La langue (#846)
 *
 * Tous les libellés viennent du namespace `booking`, sous la racine `home`. Les
 * tableaux ci-dessous ne portent donc plus de phrases mais des **clés** : ce qui
 * reste en dur ici est l'ordre des sections, l'icône de chacune et la
 * photographie qui l'illustre, c'est-à-dire ce qui ne se traduit pas.
 *
 * Deux choses n'en viennent pas :
 *
 * - le **nom des deux premières portes**, qui vient de `publicExitLabels` — la
 *   source unique des destinations du parcours public (#749). Le registre
 *   `SALON_DOOR_LABELS` de `salon-doors.ts` reste figé en français le temps de
 *   l'épique #843 : cet écran lit donc la source directement, comme le fait le
 *   formulaire pour ses trois boutons ;
 * - le **prix de l'offre**, mis en forme par `lib/format.ts` dans la langue
 *   résolue. `PLAN_PRICE_LABEL` (`lib/plan.ts`) est une constante de module,
 *   évaluée à l'importation : elle ne peut pas connaître la langue de la
 *   requête, et annoncerait « 29 € » à qui lit « €29 ».
 */

/**
 * Le titre et la description de l'onglet, dans la langue résolue.
 *
 * `generateMetadata` et non un objet `metadata` constant, pour la même raison
 * que dans `layout.tsx` : un littéral ne peut pas lire la requête, et ces deux
 * phrases sont ce qu'un moteur de recherche montre de la plateforme.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('booking');

  return {
    title: t('home.metadata.title', { platform: PLATFORM_NAME }),
    description: t('home.metadata.description'),
  };
}

/** Le cookie du dernier salon est propre à chaque visiteur : aucun rendu partagé. */
export const dynamic = 'force-dynamic';

interface Feature<Key extends string> {
  readonly icon: IconName;
  /** La section du catalogue qui porte le titre et le texte de cette carte. */
  readonly key: Key;
}

const PROOFS = ['always', 'reminder', 'noDouble'] as const;

type TrustKey = 'always' | 'reminders' | 'payment' | 'noDouble';

const TRUST: readonly Feature<TrustKey>[] = [
  { icon: 'clock', key: 'always' },
  { icon: 'bell', key: 'reminders' },
  { icon: 'lock', key: 'payment' },
  { icon: 'shield', key: 'noDouble' },
];

type TradeKey = 'spa' | 'beauty' | 'hair' | 'barber';

/**
 * Les quatre métiers du périmètre, illustrés — CDC §1.1.
 *
 * La surcapitale du héros les énumère depuis #927 (« Spas · instituts ·
 * coiffure · barbiers · massage ») sans que rien ne les montre : une gérante de
 * barbershop lisait une page qui ne ressemblait qu'à un spa. Cette bande est la
 * seule de l'accueil dont le propos soit l'image ; le libellé n'y est qu'une
 * légende, et c'est pourquoi il tient en deux mots.
 *
 * Les photographies sont **informatives** ici, et non décoratives comme dans
 * les volets d'identification : elles sont le contenu de la section. Elles
 * portent donc l'`alt` du registre (`lib/photos.ts`) plutôt qu'un
 * `aria-hidden`.
 */
const TRADES: readonly { readonly key: TradeKey; readonly photo: Photo }[] = [
  { key: 'spa', photo: PHOTOS.spaInterieur },
  { key: 'beauty', photo: PHOTOS.soinVisage },
  { key: 'hair', photo: PHOTOS.salonInterieur },
  { key: 'barber', photo: PHOTOS.barbier },
];

type LoopKey = 'book' | 'confirm' | 'keep' | 'collect' | 'measure';

const LOOP: readonly Feature<LoopKey>[] = [
  { icon: 'calendar', key: 'book' },
  { icon: 'bell', key: 'confirm' },
  { icon: 'users', key: 'keep' },
  { icon: 'card', key: 'collect' },
  { icon: 'chart', key: 'measure' },
];

const FOR_CLIENTS = ['services', 'practitioner', 'noAccount', 'history', 'reschedule'] as const;

const FOR_TEAMS = ['schedule', 'records', 'staff', 'checkout', 'figures'] as const;

const STEPS = ['service', 'slot', 'done'] as const;

/** L'inscription d'un salon en libre-service (ADR 0016). */
const SIGNUP_PATH = '/inscription';

/** Ce que comprend l'offre unique — chaque ligne est une fonctionnalité livrée. */
const PLAN_INCLUDES = ['page', 'reminders', 'schedule', 'records', 'checkout', 'figures'] as const;

/** Le salon de la dernière visite, avec son nom — ou ce qu'il reste à préremplir. */
async function rememberedSalon(): Promise<{
  readonly salon: { readonly slug: string; readonly name: string } | null;
  readonly prefill: string;
}> {
  const slug = await readLastSalon();

  if (slug === null) {
    return { salon: null, prefill: '' };
  }

  const identity = await readSalonIdentity(slug);

  if (identity.status === 'found') {
    return { salon: { slug: identity.slug, name: identity.name }, prefill: '' };
  }

  // Un salon disparu n'a rien à préremplir ; une API muette, si.
  return { salon: null, prefill: identity.status === 'unavailable' ? slug : '' };
}

/**
 * Le nom des trois portes, dans la langue résolue.
 *
 * Composé ici plutôt que lu dans `SALON_DOOR_LABELS` : ce registre est figé en
 * français le temps de l'épique #843 et n'est pas dans l'empreinte de #846. Les
 * deux premières destinations gardent leur **source unique** — le registre des
 * sorties du parcours public, pour que la même page ne s'appelle pas autrement
 * ici que sur la vitrine (#749) — et seul le back-office, que rien d'autre ne
 * nomme, vient du catalogue de cet écran.
 *
 * `SalonFinder` compose la même table pour ses trois boutons, depuis les mêmes
 * deux sources : la descendre en propriété aurait changé le contrat du
 * composant, que ses propres tests montent seul. Deux compositions, mais une
 * seule écriture de chaque libellé.
 */
function doorLabels(locale: Locale, backOffice: string): Readonly<Record<SalonDoor, string>> {
  const exits = publicExitLabels(locale);

  return {
    reservation: exits.reservation,
    compte: exits.compte,
    'back-office': backOffice,
  };
}

export default async function HomePage() {
  const { salon, prefill } = await rememberedSalon();
  const t = await getTranslations('booking');
  const locale = (await getLocale()) as Locale;
  // Aucun établissement sous la main sur la racine du domaine : la région de
  // repli de `lib/format.ts` (`en` → `en-US`, `fr` → `fr-FR`) s'applique.
  const display: DisplayLocale = { locale, countryCode: null };
  const doors = doorLabels(locale, t('home.common.doorBackOffice'));
  const planPrice = formatMoneyCompact(
    { amountMinor: SUBSCRIPTION_PLAN.amountMinor, currency: SUBSCRIPTION_PLAN.currency },
    display,
  );

  // Les six questions sont montées ici, et non lues par une clé construite dans
  // la boucle : trois d'entre elles portent des paramètres — une porte, la durée
  // de l'essai, le prix — que les autres n'ont pas.
  const questions: readonly { readonly question: string; readonly answer: string }[] = [
    {
      question: t('home.faq.address.question'),
      answer: t('home.faq.address.answer'),
    },
    {
      question: t('home.faq.account.question'),
      answer: t('home.faq.account.answer'),
    },
    {
      question: t('home.faq.reschedule.question'),
      // La porte est nommée par le registre et non recopiée : cette réponse
      // désigne le bouton qui se trouve juste au-dessus, et deux libellés écrits
      // séparément finissent par diverger — c'est l'écart que #749 a fermé.
      answer: t('home.faq.reschedule.answer', { door: doors.compte }),
    },
    {
      question: t('home.faq.card.question'),
      answer: t('home.faq.card.answer'),
    },
    {
      question: t('home.faq.price.question'),
      answer: t('home.faq.price.answer', {
        days: SUBSCRIPTION_PLAN.trialDays,
        price: planPrice,
      }),
    },
    {
      question: t('home.faq.staff.question'),
      answer: t('home.faq.staff.answer', { door: doors['back-office'] }),
    },
  ];

  return (
    <div className="spa-home">
      <header className="spa-home-bar">
        <div className="spa-home-bar__inner">
          <Link className="spa-home-bar__brand" href={PLATFORM_HOME_PATH}>
            <span className="spa-home-bar__mark" aria-hidden="true">
              <Icon name="leaf" />
            </span>
            <span className="spa-home-bar__name">{PLATFORM_NAME}</span>
          </Link>
          <nav className="spa-home-bar__nav" aria-label={t('home.nav.label')}>
            <a className="spa-home-bar__link" href="#parcours">
              {t('home.nav.features')}
            </a>
            <a className="spa-home-bar__link" href="#reserver">
              {t('home.nav.howItWorks')}
            </a>
            <a className="spa-home-bar__link" href="#tarifs">
              {t('home.nav.pricing')}
            </a>
            <a className="spa-home-bar__link" href="#questions">
              {t('home.nav.questions')}
            </a>
            <a className="spa-home-bar__link spa-home-bar__link--access" href="#acces">
              {t('home.common.accessSalon')}
            </a>
            <Link className="spa-home-bar__cta" href={SIGNUP_PATH}>
              {t('home.nav.trial')}
            </Link>
          </nav>
        </div>
      </header>

      <main id="contenu">
        <section className="spa-home-hero" aria-labelledby="accueil-titre">
          <div className="spa-home__inner spa-home-hero__inner">
            <div className="spa-home-hero__copy">
              <p className="spa-home__eyebrow">{t('home.hero.eyebrow')}</p>
              <h1 className="spa-home-hero__title" id="accueil-titre">
                {/* L'accent porte la seconde moitié de la phrase : la coupure est
                    dans le message, chaque langue décidant où elle tombe. */}
                {t.rich('home.hero.title', {
                  accent: (chunks) => (
                    <span className="spa-home-hero__title-accent">{chunks}</span>
                  ),
                })}
              </h1>
              <p className="spa-home-hero__lead">{t('home.hero.lead')}</p>
              <ul className="spa-home-hero__proofs">
                {PROOFS.map((proof) => (
                  <li className="spa-home-hero__proof" key={proof}>
                    <Icon name="check" className="spa-home-hero__proof-icon" />
                    {/* Clé construite puis fixée par un `as`, comme le fait
                        `components/ui/locale-switcher.tsx` : le suffixe vient
                        d'une union fermée de trois valeurs, toutes présentes
                        dans les deux catalogues. */}
                    {t(`home.hero.proofs.${proof}` as 'home.hero.proofs.always')}
                  </li>
                ))}
              </ul>
            </div>

            <div className="spa-home-hero__access" id="acces">
              {salon === null ? null : (
                <section className="spa-home-return" aria-labelledby="retour-titre">
                  <p className="spa-home-return__eyebrow">
                    <Icon name="store" className="spa-home-return__eyebrow-icon" />
                    {t('home.returning.eyebrow')}
                  </p>
                  <h2 className="spa-home-return__name" id="retour-titre">
                    <Link href={salonPath(salon.slug)}>{salon.name}</Link>
                  </h2>
                  <ul className="spa-home-return__doors">
                    {SALON_DOORS.map((door) => (
                      <li key={door}>
                        <Link className="spa-home-return__door" href={salonDoorPath(salon.slug, door)}>
                          {doors[door]}
                          <Icon name="arrow" className="spa-home-return__door-icon" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <SalonFinder
                initialAddress={prefill}
                title={salon === null ? t('home.common.accessSalon') : t('home.finder.titleOther')}
              />
            </div>
          </div>
        </section>

        <section className="spa-home-trust" aria-label={t('home.trust.label')}>
          <ul className="spa-home__inner spa-home-trust__list">
            {TRUST.map((item) => (
              <li className="spa-home-trust__item" key={item.key}>
                <span className="spa-home__badge">
                  <Icon name={item.icon} />
                </span>
                <p className="spa-home-trust__text">
                  <strong>{t(`home.trust.${item.key}.title` as 'home.trust.always.title')}</strong>
                  <span>{t(`home.trust.${item.key}.text` as 'home.trust.always.text')}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="spa-home-trades" aria-labelledby="metiers-titre">
          <div className="spa-home__inner">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">{t('home.trades.eyebrow')}</p>
              <h2 className="spa-home-section__title" id="metiers-titre">
                {t('home.trades.title')}
              </h2>
              <p className="spa-home-section__lead">{t('home.trades.lead')}</p>
            </div>
            <ul className="spa-home-trades__list">
              {TRADES.map((trade) => (
                <li className="spa-home-trades__item" key={trade.key}>
                  {/*
                    `sizes` décrit la place réellement occupée, sinon Next sert
                    l'image pleine largeur de l'écran pour une vignette de
                    quatre colonnes. Les paliers suivent ceux de la grille
                    ci-contre, dans `home.css`.
                  */}
                  <Image
                    className="spa-home-trades__photo"
                    src={trade.photo.src}
                    alt={trade.photo.alt}
                    width={trade.photo.width}
                    height={trade.photo.height}
                    sizes="(min-width: 60rem) 25vw, (min-width: 40rem) 50vw, 100vw"
                  />
                  <span className="spa-home-trades__label">
                    {t(`home.trades.${trade.key}` as 'home.trades.spa')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="spa-home-section" id="parcours" aria-labelledby="parcours-titre">
          <div className="spa-home__inner">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">{t('home.loop.eyebrow')}</p>
              <h2 className="spa-home-section__title" id="parcours-titre">
                {t('home.loop.title')}
              </h2>
              <p className="spa-home-section__lead">{t('home.loop.lead')}</p>
            </div>
            {/* `role="list"` explicite : le socle retire le marqueur de tout `<ol>`,
                et Safari retire alors la sémantique de liste à VoiceOver — or
                l'ordre des cinq étapes est le propos (styles/README.md §3). */}
            <ol className="spa-home-loop" role="list">
              {LOOP.map((step, index) => (
                <li className="spa-home-loop__step" key={step.key}>
                  <div className="spa-home-loop__top">
                    <span className="spa-home__badge">
                      <Icon name={step.icon} />
                    </span>
                    <span className="spa-home-loop__index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <h3 className="spa-home-loop__title">
                    {t(`home.loop.${step.key}.title` as 'home.loop.book.title')}
                  </h3>
                  <p className="spa-home-loop__text">
                    {t(`home.loop.${step.key}.text` as 'home.loop.book.text')}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="spa-home-section spa-home-section--sunken" aria-labelledby="publics-titre">
          <div className="spa-home__inner">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">{t('home.audiences.eyebrow')}</p>
              <h2 className="spa-home-section__title" id="publics-titre">
                {t('home.audiences.title')}
              </h2>
            </div>
            <div className="spa-home-audiences">
              <article className="spa-home-audience" aria-labelledby="clientele-titre">
                {/*
                  Pas `massageDos` ici, bien qu'elle soit la scène la plus
                  juste pour une cliente : c'est un portrait (1100 × 1650) dont
                  le centre est un drap blanc, et le recadrage en 16/9 de ce
                  bandeau n'en garde qu'un aplat clair — une carte qui paraît
                  n'avoir pas chargé son image. Elle sert le volet vertical de
                  la connexion cliente, où sa hauteur est un avantage.
                */}
                <Image
                  className="spa-home-audience__photo"
                  src={PHOTOS.natureMorteSpa.src}
                  alt={PHOTOS.natureMorteSpa.alt}
                  width={PHOTOS.natureMorteSpa.width}
                  height={PHOTOS.natureMorteSpa.height}
                  sizes="(min-width: 48rem) 50vw, 100vw"
                />
                <span className="spa-home__badge">
                  <Icon name="sparkle" />
                </span>
                <h3 className="spa-home-audience__title" id="clientele-titre">
                  {t('home.audiences.clients.title')}
                </h3>
                <ul className="spa-home-audience__list">
                  {FOR_CLIENTS.map((item) => (
                    <li className="spa-home-audience__item" key={item}>
                      <Icon name="check" className="spa-home-audience__check" />
                      {t(`home.audiences.clients.${item}` as 'home.audiences.clients.services')}
                    </li>
                  ))}
                </ul>
                <a className="spa-home-audience__link" href="#acces">
                  {t('home.audiences.clients.link')}
                  <Icon name="arrow" className="spa-home-audience__link-icon" />
                </a>
              </article>
              <article
                className="spa-home-audience spa-home-audience--brand"
                aria-labelledby="equipe-titre"
              >
                <Image
                  className="spa-home-audience__photo"
                  src={PHOTOS.coiffureBrushing.src}
                  alt={PHOTOS.coiffureBrushing.alt}
                  width={PHOTOS.coiffureBrushing.width}
                  height={PHOTOS.coiffureBrushing.height}
                  sizes="(min-width: 48rem) 50vw, 100vw"
                />
                <span className="spa-home__badge spa-home__badge--brand">
                  <Icon name="store" />
                </span>
                <h3 className="spa-home-audience__title" id="equipe-titre">
                  {t('home.audiences.teams.title')}
                </h3>
                <ul className="spa-home-audience__list">
                  {FOR_TEAMS.map((item) => (
                    <li className="spa-home-audience__item" key={item}>
                      <Icon name="check" className="spa-home-audience__check" />
                      {t(`home.audiences.teams.${item}` as 'home.audiences.teams.schedule')}
                    </li>
                  ))}
                </ul>
                <a className="spa-home-audience__link" href="#acces">
                  {t('home.audiences.teams.link')}
                  <Icon name="arrow" className="spa-home-audience__link-icon" />
                </a>
                <Link className="spa-home-audience__link" href={SIGNUP_PATH}>
                  {t('home.audiences.teams.signup')}
                  <Icon name="arrow" className="spa-home-audience__link-icon" />
                </Link>
              </article>
            </div>
          </div>
        </section>

        <section className="spa-home-section" id="reserver" aria-labelledby="reserver-titre">
          <div className="spa-home__inner spa-home-steps">
            <div className="spa-home-steps__copy">
              <div className="spa-home-section__heading">
                <p className="spa-home__eyebrow">{t('home.steps.eyebrow')}</p>
                <h2 className="spa-home-section__title" id="reserver-titre">
                  {t('home.steps.title')}
                </h2>
              </div>
              {/* Même raison : les trois gestes se font dans cet ordre. */}
              <ol className="spa-home-steps__list" role="list">
                {STEPS.map((step, index) => (
                  <li className="spa-home-steps__item" key={step}>
                    <span className="spa-home-steps__number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="spa-home-steps__title">
                        {t(`home.steps.${step}.title` as 'home.steps.service.title')}
                      </h3>
                      <p className="spa-home-steps__text">
                        {t(`home.steps.${step}.text` as 'home.steps.service.text')}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <BookingPreview />
          </div>
        </section>

        <section className="spa-home-section" id="tarifs" aria-labelledby="tarifs-titre">
          <div className="spa-home__inner spa-home-pricing">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">{t('home.pricing.eyebrow')}</p>
              <h2 className="spa-home-section__title" id="tarifs-titre">
                {t('home.pricing.title')}
              </h2>
            </div>
            <article className="spa-home-pricing__card" aria-labelledby="offre-titre">
              <h3 className="spa-home-pricing__name" id="offre-titre">
                {/* Le nom de l'offre est celui du produit : une marque ne se traduit pas. */}
                {SUBSCRIPTION_PLAN.name}
              </h3>
              <p className="spa-home-pricing__price">
                <span className="spa-home-pricing__amount">{planPrice}</span>
                <span className="spa-home-pricing__period">{t('home.pricing.period')}</span>
              </p>
              <p className="spa-home-pricing__trial">
                {t('home.pricing.trial', { days: SUBSCRIPTION_PLAN.trialDays })}
              </p>
              <ul className="spa-home-pricing__list">
                {PLAN_INCLUDES.map((item) => (
                  <li className="spa-home-pricing__item" key={item}>
                    <Icon name="check" className="spa-home-pricing__check" />
                    {t(`home.pricing.includes.${item}` as 'home.pricing.includes.page')}
                  </li>
                ))}
              </ul>
              <Link className="spa-home-pricing__cta" href={SIGNUP_PATH}>
                {t('home.pricing.cta')}
                <Icon name="arrow" className="spa-home-pricing__cta-icon" />
              </Link>
            </article>
          </div>
        </section>

        <section
          className="spa-home-section spa-home-section--sunken"
          id="questions"
          aria-labelledby="questions-titre"
        >
          <div className="spa-home__inner spa-home-faq">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">{t('home.faq.eyebrow')}</p>
              <h2 className="spa-home-section__title" id="questions-titre">
                {t('home.faq.title')}
              </h2>
            </div>
            <div className="spa-home-faq__list">
              {questions.map((item) => (
                <details className="spa-home-faq__item" key={item.question}>
                  <summary className="spa-home-faq__question">{item.question}</summary>
                  <p className="spa-home-faq__answer">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="spa-home-closing" aria-labelledby="fin-titre">
          <div className="spa-home__inner spa-home-closing__inner">
            <h2 className="spa-home-closing__title" id="fin-titre">
              {t('home.closing.title')}
            </h2>
            <a className="spa-home-closing__link" href="#acces">
              {t('home.common.accessSalon')}
              <Icon name="arrow" className="spa-home-closing__link-icon" />
            </a>
            <Link className="spa-home-closing__link" href={SIGNUP_PATH}>
              {t('home.closing.signup', { days: SUBSCRIPTION_PLAN.trialDays })}
              <Icon name="arrow" className="spa-home-closing__link-icon" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="spa-home-footer">
        <div className="spa-home__inner spa-home-footer__inner">
          <p className="spa-home-footer__brand">{PLATFORM_NAME}</p>
          <p className="spa-home-footer__text">{t('home.footer.text')}</p>
          {/* Le sélecteur de thème du back-office, sur le même cookie (#1114).
              Dans le pied et non dans la barre : même à 1280 px, ses trois
              pastilles faisaient passer la marque et deux ancres sur deux
              lignes. */}
          <ThemeToggle className="spa-home-footer__theme" />
        </div>
      </footer>
    </div>
  );
}
