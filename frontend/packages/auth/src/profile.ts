import type { JojoAuthClient } from "./client";
import type { Profile } from "./types";

interface ProfileRepository {
  getOrCreate: (userId: string) => Promise<Profile>;
  uploadAvatar: (userId: string, previousPath: string | null, file: File) => Promise<Profile>;
  uploadAvatarData: (
    userId: string,
    previousPath: string | null,
    contents: ArrayBuffer,
    extension: string,
    contentType: string,
  ) => Promise<Profile>;
}

export function createProfileRepository(client: JojoAuthClient): ProfileRepository {
  const getOrCreate = async (userId: string): Promise<Profile> => {
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw error;
    if (data) return data;

    const { data: created, error: createError } = await client
      .from("profiles")
      .insert({ id: userId })
      .select("*")
      .single();
    if (createError) throw createError;
    return created;
  };

  const uploadAvatarData = async (
    userId: string,
    previousPath: string | null,
    contents: ArrayBuffer,
    extension: string,
    contentType: string,
  ): Promise<Profile> => {
    const safeExtension = /^(jpe?g|png|webp)$/.test(extension.toLowerCase())
      ? extension.toLowerCase()
      : "jpg";
    const uniquePart = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const path = `${userId}/${uniquePart}.${safeExtension}`;
    const { error: uploadError } = await client.storage.from("avatars").upload(path, contents, {
      cacheControl: "3600",
      contentType,
      upsert: false,
    });
    if (uploadError) throw uploadError;

    const { data, error } = await client
      .from("profiles")
      .update({ avatar_path: path })
      .eq("id", userId)
      .select("*")
      .single();
    if (error) {
      await client.storage.from("avatars").remove([path]);
      throw error;
    }

    if (previousPath) {
      await client.storage.from("avatars").remove([previousPath]);
    }
    return data;
  };

  const uploadAvatar = async (
    userId: string,
    previousPath: string | null,
    file: File,
  ): Promise<Profile> => uploadAvatarData(
    userId,
    previousPath,
    await file.arrayBuffer(),
    file.name.split(".").pop() || "jpg",
    file.type,
  );

  return { getOrCreate, uploadAvatar, uploadAvatarData };
}
