/**
 * 会话键与聊天文件名映射。
 */

export type MessageType = 'private' | 'group';

/** 私聊：private_<uin>；群聊：group_<gid>_<uid> */
export function sessionKeyOf(
    messageType: MessageType,
    groupId: number | null,
    userId: number,
): string {
    return messageType === 'group'
        ? `group_${groupId}_${userId}`
        : `private_${userId}`;
}

/** sessionKey -> 酒馆聊天文件名 */
export function chatNameOf(sessionKey: string): string {
    if (sessionKey.startsWith('group_')) {
        return 'GROUP_' + sessionKey.slice('group_'.length);
    }
    if (sessionKey.startsWith('private_')) {
        return 'QQ_' + sessionKey.slice('private_'.length);
    }
    return 'QQ_' + sessionKey;
}

/** 从 sessionKey 还原路由信息 */
export function parseSessionKey(sessionKey: string): {
    messageType: MessageType;
    groupId: number | null;
    userId: number;
} | null {
    const priv = /^private_(\d+)$/.exec(sessionKey);
    if (priv) {
        return { messageType: 'private', groupId: null, userId: Number(priv[1]) };
    }
    const grp = /^group_(\d+)_(\d+)$/.exec(sessionKey);
    if (grp) {
        return { messageType: 'group', groupId: Number(grp[1]), userId: Number(grp[2]) };
    }
    return null;
}
