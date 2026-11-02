import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";

export const dynamic = "force-dynamic";

export default function Home() {
  const { id, name } = localDeviceIdentity(readActivityConfig(), new Date().toISOString());
  return (
    <Suspense>
      <AppShell localDeviceId={id} localDeviceName={name} />
    </Suspense>
  );
}
