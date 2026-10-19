-- L'appareil d'origine appartient au message : l'information doit survivre au
-- redemarrage au meme titre que son contenu. La colonne reste nullable pour les
-- messages systeme, outil et assistant, ainsi que pour l'historique existant.
ALTER TABLE "messages" ADD COLUMN "originClientDeviceId" UUID;
