/*
  Warnings:

  - A unique constraint covering the columns `[replyToken]` on the table `PendingReply` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "PendingReply_replyToken_key" ON "PendingReply"("replyToken");
