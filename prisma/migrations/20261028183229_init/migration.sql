-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'PSE', 'CASH_ON_DELIVERY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('AUTHORIZED', 'DECLINED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "reason" TEXT,
    "card_last4" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "producer_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "gross" INTEGER NOT NULL,
    "commission" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_buyer_id_idx" ON "payments"("buyer_id");

-- CreateIndex
CREATE INDEX "settlements_producer_id_idx" ON "settlements"("producer_id");

-- CreateIndex
CREATE INDEX "settlements_order_id_idx" ON "settlements"("order_id");
