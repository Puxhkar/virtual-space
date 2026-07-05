import type Phaser from "phaser";
import {
  idleFrame,
  type AssetManifest,
  type Facing,
  type PlayerState,
  type PresenceStatus,
  type ProximityPeer,
  type Vec2,
} from "@vo/shared";

/**
 * Other people in the office.
 *
 * Positions arrive at the server's broadcast rate, not the frame rate, so
 * sprites are moved toward a target each frame rather than snapped to it.
 * Snapping at 12Hz reads as stuttering even though the data is correct
 * (CLAUDE.md §14, §20).
 */

/** Colour per presence state. Semantic, not decorative. */
const PRESENCE_COLOR: Record<PresenceStatus, number> = {
  online: 0x4ade80,
  away: 0xfbbf24,
  in_meeting: 0xf87171,
  focus: 0xa78bfa,
  offline: 0x71717a,
};

/** Fraction of the remaining gap closed per frame at 60fps. */
const LERP = 0.25;
/** Beyond this the sprite teleports — the player was moved, not walked. */
const SNAP_DISTANCE = 96;

interface Remote {
  userId: string;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  dot: Phaser.GameObjects.Arc;
  /** Ring drawn while this person is speaking. */
  ring: Phaser.GameObjects.Arc;
  target: Vec2;
  facing: Facing;
  presence: PresenceStatus;
  zoneId: string | null;
  variantIndex: number;
}

export class RemotePlayers {
  private readonly players = new Map<string, Remote>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly manifest: AssetManifest,
  ) {}

  /** Replaces everyone. Used on join and on every reconnect. */
  reset(players: PlayerState[], selfUserId: string): void {
    for (const userId of [...this.players.keys()]) this.remove(userId);
    for (const player of players) {
      if (player.userId !== selfUserId) this.add(player);
    }
  }

  add(player: PlayerState): void {
    if (this.players.has(player.userId)) {
      this.update(player.userId, player.position, player.facing);
      return;
    }

    const { characters } = this.manifest;
    const variantIndex = this.variantFor(player.avatarKey, player.userId);
    const frame = idleFrame(characters, variantIndex, player.facing);

    const sprite = this.scene.add
      .sprite(player.position.x, player.position.y, characters.key, frame)
      .setDepth(5);

    const labelY = player.position.y - this.manifest.characters.frameHeight / 2;
    const label = this.scene.add
      .text(player.position.x, labelY, player.displayName, {
        fontSize: "8px",
        color: "#e9eaea",
        backgroundColor: "#101314cc",
        padding: { x: 2, y: 1 },
      })
      .setOrigin(0.5, 1)
      .setDepth(6);

    const dot = this.scene.add
      .circle(
        player.position.x + 9,
        labelY + 4,
        2.5,
        PRESENCE_COLOR[player.presence],
      )
      .setDepth(7);

    const ring = this.scene.add
      .circle(player.position.x, player.position.y + 14, 12)
      .setStrokeStyle(1.5, 0x4ade80, 0.9)
      .setDepth(4)
      .setVisible(false);

    this.players.set(player.userId, {
      userId: player.userId,
      sprite,
      label,
      dot,
      ring,
      target: { ...player.position },
      facing: player.facing,
      presence: player.presence,
      zoneId: player.zoneId,
      variantIndex,
    });
  }

  update(userId: string, position: Vec2, facing: Facing): void {
    const remote = this.players.get(userId);
    if (!remote) return;

    remote.target = { ...position };
    if (remote.facing !== facing) {
      remote.facing = facing;
      this.applyFrame(remote);
    }
  }

  setPresence(userId: string, presence: PresenceStatus): void {
    const remote = this.players.get(userId);
    if (!remote) return;
    remote.presence = presence;
    remote.dot.setFillStyle(PRESENCE_COLOR[presence]);
    // An away or offline teammate is still there, just dimmed.
    remote.sprite.setAlpha(
      presence === "away" || presence === "offline" ? 0.55 : 1,
    );
  }

  /**
   * Shows a ring around whoever is currently speaking.
   *
   * Without it, hearing a voice and not knowing which of five avatars it came
   * from is the single most disorienting thing about a spatial office.
   */
  setSpeaking(userIds: readonly string[]): void {
    const speaking = new Set(userIds);
    for (const remote of this.players.values()) {
      remote.ring.setVisible(speaking.has(remote.userId));
    }
  }

  setZone(userId: string, zoneId: string | null): void {
    const remote = this.players.get(userId);
    if (remote) remote.zoneId = zoneId;
  }

  /**
   * Positions for the proximity engine.
   *
   * Uses the interpolated sprite position rather than the last received
   * target, so what you can hear matches what you can see. Deciding on the
   * target would mean audio arriving before the avatar does.
   */
  peers(): ProximityPeer[] {
    const out: ProximityPeer[] = [];
    for (const remote of this.players.values()) {
      out.push({
        userId: remote.userId,
        position: { x: remote.sprite.x, y: remote.sprite.y },
        zoneId: remote.zoneId,
      });
    }
    return out;
  }

  remove(userId: string): void {
    const remote = this.players.get(userId);
    if (!remote) return;
    remote.sprite.destroy();
    remote.label.destroy();
    remote.dot.destroy();
    remote.ring.destroy();
    this.players.delete(userId);
  }

  /** Called every frame. Eases each sprite toward its last known position. */
  tick(): void {
    for (const remote of this.players.values()) {
      const { sprite, target } = remote;
      const dx = target.x - sprite.x;
      const dy = target.y - sprite.y;

      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
        this.stopAnimation(remote);
      } else if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) {
        sprite.setPosition(target.x, target.y);
      } else {
        sprite.setPosition(sprite.x + dx * LERP, sprite.y + dy * LERP);
        this.playAnimation(remote);
      }

      const top = sprite.y - this.manifest.characters.frameHeight / 2;
      remote.label.setPosition(sprite.x, top);
      remote.dot.setPosition(sprite.x + 9, top + 4);
      remote.ring.setPosition(sprite.x, sprite.y + 14);
    }
  }

  count(): number {
    return this.players.size;
  }

  destroy(): void {
    for (const userId of [...this.players.keys()]) this.remove(userId);
  }

  /* ------------------------------------------------------------------ */

  private applyFrame(remote: Remote): void {
    remote.sprite.setFrame(
      idleFrame(this.manifest.characters, remote.variantIndex, remote.facing),
    );
  }

  private playAnimation(remote: Remote): void {
    const key = `walk-${remote.variantIndex}-${remote.facing}`;
    if (this.scene.anims.exists(key)) remote.sprite.anims.play(key, true);
  }

  private stopAnimation(remote: Remote): void {
    remote.sprite.anims.stop();
    this.applyFrame(remote);
  }

  /**
   * Which character variant to draw.
   *
   * Falls back to hashing the user id so two people never look identical even
   * if the server sends an avatar key the manifest does not have.
   */
  private variantFor(avatarKey: string, userId: string): number {
    const variants = this.manifest.characters.variants;
    const named = variants.findIndex((v) => v.key === avatarKey);
    if (named >= 0) return named;

    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash * 31 + userId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % variants.length;
  }
}
