import { VendorProfileView } from '@/components/vendor-profile/vendor-profile-view';

export default async function VendorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  return <VendorProfileView vendorId={id} />;
}
