-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_elo_wins_idx" ON "User"("elo", "wins");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
