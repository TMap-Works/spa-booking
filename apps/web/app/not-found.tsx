import { useTranslations } from 'next-intl';

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
 */
export default function NotFound() {
  const t = useTranslations('shell.notFound');

  return (
    <main className="spa-empty-state">
      <h1 className="spa-empty-state__title">{t('title')}</h1>
      <p className="spa-empty-state__description">{t('description')}</p>
    </main>
  );
}
