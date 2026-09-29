import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/ui/locale-switcher';

/**
 * Page servie sur un `notFound()` ou une adresse inconnue.
 *
 * Elle ne distingue pas l'établissement qui n'existe pas de celui qui est
 * désactivé : l'API répond 404 dans les deux cas, et un message qui les
 * séparerait confirmerait l'existence d'un salon à qui essaie des slugs au
 * hasard (tenant-isolation §4).
 *
 * Traduite depuis #845 : c'est la seule page que tout visiteur peut atteindre
 * sans passer par un salon, et la langue y est déjà résolue par le layout
 * racine.
 *
 * ## Le sélecteur de langue — #1326
 *
 * Elle n'en portait aucun, et elle est précisément la page où l'on arrive sans
 * coquille : ni pied de salon, ni rail de back-office pour en offrir un. Un
 * visiteur qui atterrissait ici dans une langue qu'il ne lit pas n'avait aucun
 * moyen d'en changer, sauf à trouver d'abord une vraie page.
 *
 * Il n'y a **aucun salon** ici, et c'est le second point : le sélecteur n'en
 * demande pas. Il ne pose qu'un cookie de préférence par action serveur, sur `/`
 * — ni `tenantSlug`, ni session, ni appel d'API (`i18n/actions.ts`). La page se
 * rejoue ensuite dans la langue choisie, toujours en 404.
 */
export default function NotFound() {
  const t = useTranslations('shell.notFound');

  return (
    <main className="spa-empty-state">
      <h1 className="spa-empty-state__title">{t('title')}</h1>
      <p className="spa-empty-state__description">{t('description')}</p>
      <LocaleSwitcher className="spa-locale-switcher--centered spa-locale-switcher--detached" />
    </main>
  );
}
