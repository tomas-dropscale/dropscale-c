"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, FieldError } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { Rich } from "@/components/ui/rich-text";
import { createClient } from "@/lib/supabase/client";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/** Built per-locale so the validation messages are translated too. */
function accountSchema(d: Dictionary) {
  return z.object({
    storeName: z.string().trim().min(2, { message: d.accounts.nameRequired }).max(80),
    customerId: z
      .string()
      .trim()
      .regex(/^[\d-]*$/, { message: d.accounts.customerIdFormat })
      .optional()
      .or(z.literal("")),
  });
}

type FormValues = z.infer<ReturnType<typeof accountSchema>>;

export function AddAccountModal({
  open,
  onOpenChange,
  clientId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
}) {
  const router = useRouter();
  const { d } = useI18n();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const schema = React.useMemo(() => accountSchema(d), [d]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { storeName: "", customerId: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    const { error } = await createClient().from("ad_accounts").insert({
      client_id: clientId,
      store_name: values.storeName,
      google_ads_customer_id: values.customerId || null,
      status: "pending",
    });

    if (error) {
      setServerError(error.message);
      return;
    }

    reset();
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{d.accounts.addTitle}</DialogTitle>
          <DialogDescription>{d.accounts.addSubtitle}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {serverError && <FormAlert>{serverError}</FormAlert>}

          {/* Set expectations up front: adding is not the same as being live. */}
          <div className="flex items-start gap-2 rounded-[8px] border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/10 px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <Clock className="mt-0.5 size-3.5 shrink-0 text-[var(--warning-orange)]" aria-hidden />
            <span>
              <Rich text={d.accounts.addPendingNotice} />
            </span>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="storeName">{d.accounts.accountName}</Label>
            <Input
              id="storeName"
              placeholder={d.accounts.accountNamePlaceholder}
              aria-invalid={Boolean(errors.storeName)}
              {...register("storeName")}
            />
            <FieldError>{errors.storeName?.message}</FieldError>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="customerId">{d.accounts.customerId}</Label>
            <Input
              id="customerId"
              placeholder={d.accounts.customerIdPlaceholder}
              aria-invalid={Boolean(errors.customerId)}
              {...register("customerId")}
            />
            <FieldError>{errors.customerId?.message}</FieldError>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            loading={isSubmitting}
          >
            {d.accounts.add}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
