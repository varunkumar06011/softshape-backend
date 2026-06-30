-- Add userId column to Employee to link login staff (User) with payroll staff (Employee)
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- Add unique constraint on userId
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_key" UNIQUE ("userId");

-- Add foreign key from Employee.userId to User.id
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add index on userId
CREATE INDEX IF NOT EXISTS "Employee_userId_idx" ON "Employee"("userId");
