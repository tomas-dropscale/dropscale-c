"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { createClient } from "@/lib/supabase/client";

const schema = z.object({
  storeName: z.string().trim().min(2, { message: "Enter the account name." }).max(80),
  customerId: z
    .string()
    .trim()
    .regex(/^[\d-]*$/, { message: "Digits and dashes only, e.g. 123-456-7890." })
    .optional()
    .or(z.literal("")),
});

type FormValues = z.infer<typeof schema>;

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
  const [serverError, setServerError] = React.useState<string | null>(null);

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
          <DialogTitle>Add Account</DialogTitle>
          <DialogDescription>
            Link an existing Google Ads account to your portal.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {serverError && <FormAlert>{serverError}</FormAlert>}

          <div className="space-y-1.5">
            <Label htmlFor="storeName">Account Name</Label>
            <Input
              id="storeName"
              placeholder="e.g. My Store"
              aria-invalid={Boolean(errors.storeName)}
              {...register("storeName")}
            />
            <FieldError>{errors.storeName?.message}</FieldError>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="customerId">Customer ID</Label>
            <Input
              id="customerId"
              placeholder="e.g. 123-456-7890"
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
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
