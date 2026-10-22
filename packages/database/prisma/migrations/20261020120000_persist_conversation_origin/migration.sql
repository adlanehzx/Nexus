-- The origin device belongs to the message: this information must persist
-- across restarts just like message content. The column remains nullable for
-- system, tool, and assistant messages, as well as for existing history.
ALTER TABLE "messages" ADD COLUMN "originClientDeviceId" UUID;
