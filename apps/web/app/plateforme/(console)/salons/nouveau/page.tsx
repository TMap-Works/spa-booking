import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TenantCreateForm } from '../../../components/tenant-create-form';

/**
 * Le titre de l'onglet de cet écran (#1329).
 *
 * Le gabarit de l'espace le situe — « … · Console plateforme ». Sans ce
 * titre-ci, l'onglet portait le seul nom de l'espace, et deux écrans ouverts
 * côte à côte étaient indiscernables.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platform');

  return { title: t('meta.create') };
}

/** Ouvrir un salon : l'établissement, son adresse, sa langue, et le gérant à inviter. */
export default async function NewTenantPage() {
  const t = await getTranslations('platform');

  return (
    <section aria-labelledby="nouveau-salon-titre">
      <h1 className="spa-admin__title" id="nouveau-salon-titre">
        {t('create.title')}
      </h1>
      <TenantCreateForm />
    </section>
  );
}
