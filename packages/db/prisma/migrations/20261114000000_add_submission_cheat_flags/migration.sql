-- CreateTable
-- Anti-cheat findings live in their own table (no foreign keys, no change to "Submission"), so this migration is
-- purely additive and the application keeps working on a database that has not run it yet.
CREATE TABLE IF NOT EXISTS "SubmissionCheatFlag" (
    "submissionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT,
    "problemId" TEXT NOT NULL,
    "flags" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionCheatFlag_pkey" PRIMARY KEY ("submissionId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubmissionCheatFlag_userId_idx" ON "SubmissionCheatFlag"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubmissionCheatFlag_matchId_idx" ON "SubmissionCheatFlag"("matchId");
