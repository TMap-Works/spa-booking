import { getTranslations } from 'next-intl/server';

import { TenantCreateForm } from '../../../components/tenant-create-form';

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
