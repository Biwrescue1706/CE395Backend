-- CreateTable
CREATE TABLE "PendingReply" (
    "id" SERIAL NOT NULL,
    "replyToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageType" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingReply_pkey" PRIMARY KEY ("id")
);
