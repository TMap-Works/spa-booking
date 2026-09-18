import { TenantCreateForm } from '../../../components/tenant-create-form';

/** Ouvrir un salon : l'établissement, son adresse, et le gérant à inviter. */
export default function NewTenantPage() {
  return (
    <section aria-labelledby="nouveau-salon-titre">
      <h1 className="spa-admin__title" id="nouveau-salon-titre">
        Ouvrir un salon
      </h1>
      <TenantCreateForm />
    </section>
  );
}
