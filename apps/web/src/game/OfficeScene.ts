import Phaser from "phaser";
import {
  PROXIMITY,
  REALTIME,
  applyDecision,
  decideProximity,
  idleFrame,
  walkCycleFrames,
  type AssetManifest,
  type Facing,
  type ProximityDecision,
  type ProximityState,
  type Zone,
  TILESETS,
} from "@vo/shared";
import { assetUrl } from "./manifest";
import { RemotePlayers } from "./RemotePlayers";
import type { RealtimeClient } from "./realtime";

/**
 * The office.
 *
 * Local movement is predicted immediately and reported to the server on a
 * fixed tick; other people are interpolated toward the positions the server
 * broadcasts. The scene renders — it does not own the wire (that is
 * realtime.ts) and it does not own the map (that is the API).
 */

const MAP_KEY = "office";

/** How large one tile should appear on screen, regardless of its source size. */
const TARGET_TILE_PX = 48;

const FLOOR_LAYER = "floor";
const WALLS_LAYER = "walls";
const FURNITURE_LAYER = "furniture";

export interface OfficeSceneOptions {
  manifest: AssetManifest;
  /** Tiled JSON, from the API. */
  mapData: unknown;
  variantIndex: number;
  /** Omitted in single-player. */
  realtime?: RealtimeClient | undefined;
  /** Called with subscription changes whenever proximity changes. */
  onProximity?: ((decision: ProximityDecision) => void) | undefined;
  /** Called with the zone the local player is standing in, or null. */
  onZone?: ((zone: Zone | null) => void) | undefined;
  onReady?: (() => void) | undefined;
}

export class OfficeScene extends Phaser.Scene {
  private readonly manifest: AssetManifest;
  private readonly mapData: unknown;
  private readonly variantIndex: number;
  private readonly realtime: RealtimeClient | undefined;
  private readonly onProximity:
    ((decision: ProximityDecision) => void) | undefined;
  private readonly onZone: ((zone: Zone | null) => void) | undefined;
  private readonly onReady: (() => void) | undefined;

  private player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<
    "up" | "down" | "left" | "right",
    Phaser.Input.Keyboard.Key
  >;
  private facing: Facing = "down";
  private wasMoving = false;

  /** Our own user id and zone, both told to us by the server. */
  private selfUserId = "";
  private selfZoneId: string | null = null;

  /** What media is currently subscribed to, and when it was last recomputed. */
  private subscriptions: ProximityState = {
    audio: new Set(),
    video: new Set(),
  };
  private lastProximityAt = 0;

  /** Zone rectangles from the server, and the shapes drawn for them. */
  private zones: Zone[] = [];
  /**
   * Which tiles stop an avatar, as one row-string per row ("1" solid).
   *
   * A snapshot taken once the map is built — the layout cannot change during a
   * session, and the alternative is holding layer references whose Phaser type
   * varies by renderer.
   */
  private walkable?: {
    width: number;
    height: number;
    tileSize: number;
    blocked: string[];
  };
  private readonly zoneShapes = new Map<string, Phaser.GameObjects.Rectangle>();

  remotes!: RemotePlayers;

  constructor(options: OfficeSceneOptions) {
    super("OfficeScene");
    this.manifest = options.manifest;
    this.mapData = options.mapData;
    this.variantIndex = options.variantIndex;
    this.realtime = options.realtime;
    this.onProximity = options.onProximity;
    this.onZone = options.onZone;
    this.onReady = options.onReady;
  }

  preload(): void {
    const { characters } = this.manifest;

    // Every sheet in the library, because an office edited in the admin panel
    // may use any of them.
    for (const tileset of TILESETS) {
      this.load.image(tileset.key, assetUrl(tileset.file));
    }

    this.load.spritesheet(characters.key, assetUrl(characters.file), {
      frameWidth: characters.frameWidth,
      frameHeight: characters.frameHeight,
    });

    // The map is data we already hold, not a URL to fetch again.
    this.cache.tilemap.add(MAP_KEY, {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: this.mapData,
    });
  }

  create(): void {
    const { characters, tileSize } = this.manifest;

    const map = this.make.tilemap({ key: MAP_KEY });

    /*
     * Every layer is given every tileset the map declares, so a layer can mix
     * a wall from one sheet with a desk from another. Sheets the map does not
     * declare are skipped rather than thrown on — an older map naming fewer
     * of them must still open.
     */
    const sheets = TILESETS.map((tileset) =>
      map.addTilesetImage(tileset.key, tileset.key, tileSize, tileSize, 0, 0),
    ).filter((sheet): sheet is Phaser.Tilemaps.Tileset => sheet !== null);

    if (sheets.length === 0) {
      throw new Error("This office's map references no known tile sets");
    }

    map.createLayer(FLOOR_LAYER, sheets, 0, 0);
    const walls = map.createLayer(WALLS_LAYER, sheets, 0, 0);
    const furniture = map.createLayer(FURNITURE_LAYER, sheets, 0, 0);
    if (!walls || !furniture) throw new Error("Map is missing a tile layer");

    walls.setCollisionByExclusion([-1]);
    furniture.setCollisionByExclusion([-1]);
    this.walkable = {
      width: map.width,
      height: map.height,
      tileSize,
      blocked: Array.from({ length: map.height }, (_, y) =>
        Array.from({ length: map.width }, (_, x) =>
          (walls.getTileAt(x, y) ?? furniture.getTileAt(x, y)) ? "1" : "0",
        ).join(""),
      ),
    };

    this.createAnimations();
    this.remotes = new RemotePlayers(this, this.manifest);

    const spawn = this.findSpawn(map, tileSize);
    this.player = this.physics.add.sprite(
      spawn.x,
      spawn.y,
      characters.key,
      this.idleFrameFor("down"),
    );

    /*
     * The collision body is the character's feet, not the sprite.
     *
     * A 32x64 sprite is mostly head and torso — colliding with the whole
     * rectangle would stop the avatar a tile short of every wall and make
     * doorways impassable. `footOffsetY` says where the feet sit.
     */
    const { frameWidth, footOffsetY } = characters;
    this.player.body
      .setSize(Math.round(frameWidth * 0.5), 10)
      .setOffset(Math.round(frameWidth * 0.25), footOffsetY);
    this.player.setDepth(10);

    this.physics.add.collider(this.player, walls);
    this.physics.add.collider(this.player, furniture);

    this.physics.world.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.player.setCollideWorldBounds(true);

    const cam = this.cameras.main;
    cam.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    cam.startFollow(this.player, true, 0.12, 0.12);
    /*
     * Zoom is derived from the tile size, not fixed.
     *
     * A tile should occupy about TARGET_TILE_PX on screen whatever the art
     * pack's native size — otherwise swapping a 16px pack for a 32px one
     * silently halves how much of the office you can see.
     */
    cam.setZoom(Math.max(1, TARGET_TILE_PX / tileSize));
    cam.roundPixels = true;

    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("Keyboard input is unavailable");
    this.cursors = keyboard.createCursorKeys();
    this.wasd = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    // Wired last, deliberately. attach() replays the most recent snapshot
    // immediately, and its handler positions the local player — so the player
    // and the remote roster must both exist before this runs.
    this.wireRealtime();

    this.exposeTestHook();
    this.onReady?.();
  }

  override update(time: number, _delta: number): void {
    this.updateProximity(time);

    const speed = REALTIME.MAX_SPEED_PX_PER_SEC;
    const body = this.player.body;

    const left = this.cursors.left.isDown || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;
    const up = this.cursors.up.isDown || this.wasd.up.isDown;
    const down = this.cursors.down.isDown || this.wasd.down.isDown;

    let vx = 0;
    let vy = 0;
    if (left) vx -= 1;
    if (right) vx += 1;
    if (up) vy -= 1;
    if (down) vy += 1;

    if (vx !== 0 && vy !== 0) {
      // Normalise so diagonal movement is not faster than orthogonal.
      const inv = Math.SQRT1_2;
      vx *= inv;
      vy *= inv;
    }

    body.setVelocity(vx * speed, vy * speed);
    this.remotes.tick();

    const moving = vx !== 0 || vy !== 0;

    if (!moving) {
      if (this.wasMoving) {
        // Send the final position once, so other clients do not interpolate
        // toward a stale target and drift past where the avatar stopped.
        this.realtime?.reportStop(
          { x: this.player.x, y: this.player.y },
          this.facing,
        );
        this.wasMoving = false;
      }
      this.player.anims.stop();
      this.player.setFrame(this.idleFrameFor(this.facing));
      return;
    }

    // Horizontal wins ties: side views read better than front views in motion.
    this.facing =
      Math.abs(vx) >= Math.abs(vy)
        ? vx < 0
          ? "left"
          : "right"
        : vy < 0
          ? "up"
          : "down";

    this.player.anims.play(this.animKey(this.variantIndex, this.facing), true);
    this.wasMoving = true;

    this.realtime?.reportMovement(
      { x: this.player.x, y: this.player.y },
      this.facing,
      performance.now(),
    );
  }

  /** Called by the media layer when the active speakers change. */
  setSpeaking(userIds: readonly string[]): void {
    this.remotes?.setSpeaking(userIds);
  }

  /** How many people can currently hear you, and you them. */
  audibleCount(): number {
    return this.subscriptions.audio.size;
  }

  /* ----------------------------------------------------------------- */

  /**
   * Recomputes who is audible, on a fixed interval rather than every frame.
   *
   * At 60fps this would run 60 times a second for a set of decisions that
   * changes a handful of times a minute (CLAUDE.md §19). The engine itself is
   * pure and lives in @vo/shared, so the rules are unit-tested rather than
   * discovered by walking around.
   */
  private updateProximity(time: number): void {
    if (!this.onProximity) return;
    if (time - this.lastProximityAt < 1000 / PROXIMITY.RECOMPUTE_HZ) return;
    this.lastProximityAt = time;

    const decision = decideProximity(
      {
        position: { x: this.player.x, y: this.player.y },
        zoneId: this.selfZoneId,
        presence: "online",
      },
      this.remotes.peers(),
      this.subscriptions,
    );

    this.subscriptions = applyDecision(this.subscriptions, decision);
    this.onProximity(decision);
  }

  /**
   * Draws each zone as a faint outline.
   *
   * A room you cannot see the edges of is a room you walk out of by accident
   * mid-sentence. The outline is deliberately quiet — it marks a boundary
   * without competing with the map.
   */
  private drawZones(zones: Zone[]): void {
    for (const shape of this.zoneShapes.values()) shape.destroy();
    this.zoneShapes.clear();
    this.zones = zones;

    for (const zone of zones) {
      const shape = this.add
        .rectangle(
          zone.bounds.x + zone.bounds.width / 2,
          zone.bounds.y + zone.bounds.height / 2,
          zone.bounds.width,
          zone.bounds.height,
          0x5ec3c9,
          0.05,
        )
        .setStrokeStyle(1, 0x5ec3c9, 0.35)
        .setDepth(1);
      this.zoneShapes.set(zone.id, shape);
    }
  }

  /** Brightens the zone you are standing in, and tells the UI which it is. */
  private highlightZone(): void {
    for (const [id, shape] of this.zoneShapes) {
      const inside = id === this.selfZoneId;
      shape.setFillStyle(0x5ec3c9, inside ? 0.16 : 0.05);
      shape.setStrokeStyle(1, 0x5ec3c9, inside ? 0.8 : 0.35);
    }
    this.onZone?.(this.zones.find((z) => z.id === this.selfZoneId) ?? null);
  }

  private wireRealtime(): void {
    const realtime = this.realtime;
    if (!realtime) return;

    realtime.attach({
      onSnapshot: (snapshot) => {
        // A snapshot is authoritative and arrives on every reconnect, so the
        // roster is rebuilt rather than merged.
        this.selfUserId = snapshot.selfUserId;
        this.remotes.reset(snapshot.players, snapshot.selfUserId);
        this.selfZoneId =
          snapshot.players.find((p) => p.userId === snapshot.selfUserId)
            ?.zoneId ?? null;
        this.drawZones(snapshot.zones);
        this.highlightZone();
        // The server is authoritative about where we are. During normal play
        // this matches what we last sent; after a reconnect it is a correction.
        const self = snapshot.players.find(
          (p) => p.userId === snapshot.selfUserId,
        );
        if (self) this.player.setPosition(self.position.x, self.position.y);
      },
      onPlayerJoined: (player) => this.remotes.add(player),
      onPlayerLeft: (userId) => this.remotes.remove(userId),
      onPlayerMoved: (userId, position, facing) =>
        this.remotes.update(userId, position, facing),
      onPresenceChanged: (userId, presence) =>
        this.remotes.setPresence(userId, presence),
      onZoneChanged: (userId, zoneId) => {
        if (userId === this.selfUserId) {
          this.selfZoneId = zoneId;
          this.highlightZone();
        } else {
          this.remotes.setZone(userId, zoneId);
        }
      },
    });
  }

  private findSpawn(
    map: Phaser.Tilemaps.Tilemap,
    tileSize: number,
  ): { x: number; y: number } {
    const objects = map.getObjectLayer("objects");
    const spawn = objects?.objects.find((o) => o.name === "spawn");

    if (spawn?.x !== undefined && spawn.y !== undefined) {
      return { x: spawn.x + tileSize / 2, y: spawn.y + tileSize / 2 };
    }
    // Centre of the map is a safe fallback, and a visible one — if the spawn
    // object goes missing it should be obvious, not silently off-by-a-tile.
    return { x: map.widthInPixels / 2, y: map.heightInPixels / 2 };
  }

  private animKey(variantIndex: number, facing: Facing): string {
    return `walk-${variantIndex}-${facing}`;
  }

  private idleFrameFor(facing: Facing): number {
    return idleFrame(this.manifest.characters, this.variantIndex, facing);
  }

  /**
   * Animations for every variant, not just the local one — remote players use
   * whichever variant the server gave them.
   */
  private createAnimations(): void {
    const { characters } = this.manifest;
    const facings: Facing[] = ["up", "down", "left", "right"];

    for (let variant = 0; variant < characters.variants.length; variant++) {
      for (const facing of facings) {
        const key = this.animKey(variant, facing);
        if (this.anims.exists(key)) continue;

        const frames = walkCycleFrames(characters, variant, facing);
        if (frames.length === 0) continue;

        this.anims.create({
          key,
          frames: frames.map((frame) => ({ key: characters.key, frame })),
          // Six real frames, so this runs faster than the three-frame
          // approximation the previous pack needed.
          frameRate: 10,
          repeat: -1,
        });
      }
    }
  }

  /**
   * Publishes state for end-to-end tests.
   *
   * A canvas has no DOM to assert against, so without this a browser test can
   * only check that a canvas element exists — which stays true when the scene
   * is broken. Only the local player's own coordinates and a peer count are
   * exposed.
   */
  private exposeTestHook(): void {
    Object.defineProperty(window, "__office", {
      configurable: true,
      get: () => ({
        x: this.player.x,
        y: this.player.y,
        /*
         * Where the avatar actually collides — its feet, not its centre.
         *
         * The sprite is 32x64 and mostly head and torso, so the body sits
         * most of a tile below `y`. A test that plots a route from `y` starts
         * from the wrong tile and aims at tile centres that put the feet
         * inside the wall below.
         */
        body: {
          x: this.player.body.center.x,
          y: this.player.body.center.y,
        },
        facing: this.facing,
        peers: this.remotes.count(),
        zone: this.selfZoneId,
        audible: this.subscriptions.audio.size,
        // Exposed so tests can navigate to a zone by name instead of by
        // hardcoded coordinates, which change with the tile size and with
        // every map edit.
        /*
         * The walkable grid, for tests.
         *
         * Without it a test has to guess a route, and axis-by-axis walking
         * cannot find a doorway — it walks into the wall beside it. The office
         * is editable, so no test can assume a layout; they path-find over
         * this instead.
         */
        grid: this.walkable,
        zones: this.zones.map((z) => ({
          id: z.id,
          name: z.name,
          centre: {
            x: z.bounds.x + z.bounds.width / 2,
            y: z.bounds.y + z.bounds.height / 2,
          },
        })),
      }),
    });
  }
}
