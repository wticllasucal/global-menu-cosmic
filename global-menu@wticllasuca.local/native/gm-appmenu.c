/* SPDX-License-Identifier: GPL-2.0-or-later */

/*
 * Server side of the org_kde_kwin_appmenu_manager Wayland protocol for
 * Mutter. Native Wayland clients (Chromium, Firefox, Qt 6) use it to tell
 * the compositor where on the session bus the com.canonical.dbusmenu of a
 * surface lives; Mutter does not implement it, so the Global Menu extension
 * loads this into the shell process and adds the global itself.
 *
 * Everything here runs on the compositor's main thread.
 */

#include "gm-appmenu.h"

#include <gio/gio.h>
#include <wayland-server.h>

#include "appmenu-server-protocol.h"

#define APPMENU_VERSION 2
/* More menus than any real session has windows; a client asking for more is
 * misbehaving. */
#define MAX_ENTRIES 4096

/* Public libmutter symbols, declared here so that building does not need
 * the Mutter development headers. */
struct wl_display *meta_wayland_compositor_get_wayland_display (gpointer compositor);
gpointer           meta_window_get_wayland_surface             (gpointer window);

struct _GmAppmenuManager
{
  GObject parent_instance;

  struct wl_display *display;
  struct wl_global *global;
  GList *entries;
  guint n_entries;
  guint changed_idle_id;
};

typedef struct
{
  GmAppmenuManager *manager;
  /* MetaWaylandSurface the menu belongs to; only ever compared, never
   * dereferenced, and cleared as soon as the wl_surface goes away. */
  gpointer surface;
  struct wl_listener surface_destroy;
  char *service_name;
  char *object_path;
} Entry;

enum
{
  CHANGED,
  N_SIGNALS
};

static guint signals[N_SIGNALS];

G_DEFINE_FINAL_TYPE (GmAppmenuManager, gm_appmenu_manager, G_TYPE_OBJECT)

static gboolean
emit_changed_idle (gpointer user_data)
{
  GmAppmenuManager *self = user_data;

  self->changed_idle_id = 0;
  g_signal_emit (self, signals[CHANGED], 0);

  return G_SOURCE_REMOVE;
}

/* Requests arrive in the middle of Wayland dispatch; let the shell react
 * from a clean main loop iteration, once per batch. */
static void
queue_changed (GmAppmenuManager *self)
{
  if (self->changed_idle_id == 0)
    self->changed_idle_id = g_idle_add (emit_changed_idle, self);
}

static void
entry_surface_destroyed (struct wl_listener *listener,
                         void               *data)
{
  Entry *entry = wl_container_of (listener, entry, surface_destroy);

  wl_list_remove (&entry->surface_destroy.link);
  entry->surface = NULL;
  queue_changed (entry->manager);
}

static void
appmenu_set_address (struct wl_client   *client,
                     struct wl_resource *resource,
                     const char         *service_name,
                     const char         *object_path)
{
  Entry *entry = wl_resource_get_user_data (resource);

  g_free (entry->service_name);
  g_free (entry->object_path);
  entry->service_name = g_strdup (service_name);
  entry->object_path = g_strdup (object_path);
  queue_changed (entry->manager);
}

static void
appmenu_release (struct wl_client   *client,
                 struct wl_resource *resource)
{
  wl_resource_destroy (resource);
}

static const struct org_kde_kwin_appmenu_interface appmenu_implementation = {
  appmenu_set_address,
  appmenu_release,
};

static void
appmenu_resource_destroyed (struct wl_resource *resource)
{
  Entry *entry = wl_resource_get_user_data (resource);
  GmAppmenuManager *self = entry->manager;

  if (entry->surface != NULL)
    wl_list_remove (&entry->surface_destroy.link);

  self->entries = g_list_remove (self->entries, entry);
  self->n_entries--;
  g_free (entry->service_name);
  g_free (entry->object_path);
  g_free (entry);
  queue_changed (self);
}

static void
manager_create (struct wl_client   *client,
                struct wl_resource *manager_resource,
                uint32_t            id,
                struct wl_resource *surface_resource)
{
  GmAppmenuManager *self = wl_resource_get_user_data (manager_resource);
  struct wl_resource *resource;
  Entry *entry;

  if (self->n_entries >= MAX_ENTRIES)
    {
      wl_client_post_no_memory (client);
      return;
    }

  resource = wl_resource_create (client, &org_kde_kwin_appmenu_interface,
                                 wl_resource_get_version (manager_resource), id);
  if (resource == NULL)
    {
      wl_client_post_no_memory (client);
      return;
    }

  entry = g_new0 (Entry, 1);
  entry->manager = self;
  /* Mutter keeps its MetaWaylandSurface as the wl_surface user data. */
  entry->surface = wl_resource_get_user_data (surface_resource);
  entry->surface_destroy.notify = entry_surface_destroyed;
  wl_resource_add_destroy_listener (surface_resource, &entry->surface_destroy);

  /* Newest first, so the latest menu of a surface wins a lookup. */
  self->entries = g_list_prepend (self->entries, entry);
  self->n_entries++;

  wl_resource_set_implementation (resource, &appmenu_implementation, entry,
                                  appmenu_resource_destroyed);
}

static void
manager_release (struct wl_client   *client,
                 struct wl_resource *resource)
{
  wl_resource_destroy (resource);
}

static const struct org_kde_kwin_appmenu_manager_interface manager_implementation = {
  manager_create,
  manager_release,
};

static void
manager_bind (struct wl_client *client,
              void             *data,
              uint32_t          version,
              uint32_t          id)
{
  GmAppmenuManager *self = data;
  struct wl_resource *resource;

  resource = wl_resource_create (client, &org_kde_kwin_appmenu_manager_interface,
                                 MIN (version, APPMENU_VERSION), id);
  if (resource == NULL)
    {
      wl_client_post_no_memory (client);
      return;
    }

  wl_resource_set_implementation (resource, &manager_implementation, self, NULL);
}

static void
gm_appmenu_manager_class_init (GmAppmenuManagerClass *klass)
{
  /**
   * GmAppmenuManager::changed:
   *
   * A surface gained, changed or lost its menu address.
   */
  signals[CHANGED] =
    g_signal_new ("changed", G_TYPE_FROM_CLASS (klass), G_SIGNAL_RUN_LAST,
                  0, NULL, NULL, NULL, G_TYPE_NONE, 0);
}

static void
gm_appmenu_manager_init (GmAppmenuManager *self)
{
}

/**
 * gm_appmenu_manager_get_default:
 * @wayland_compositor: the shell's #MetaWaylandCompositor
 * @error: return location for an error
 *
 * Gets the manager of this process, creating it on first use. It lives
 * until the shell exits: clients keep referring to it for as long as their
 * surfaces exist.
 *
 * Returns: (transfer none): the manager, or %NULL on error
 */
GmAppmenuManager *
gm_appmenu_manager_get_default (GObject  *wayland_compositor,
                                GError  **error)
{
  static GmAppmenuManager *manager = NULL;
  struct wl_display *display;

  if (manager != NULL)
    return manager;

  if (!G_IS_OBJECT (wayland_compositor) ||
      g_strcmp0 (G_OBJECT_TYPE_NAME (wayland_compositor), "MetaWaylandCompositor") != 0)
    {
      g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT,
                           "Not a MetaWaylandCompositor");
      return NULL;
    }

  display = meta_wayland_compositor_get_wayland_display (wayland_compositor);
  if (display == NULL)
    {
      g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_FAILED,
                           "The compositor has no Wayland display");
      return NULL;
    }

  manager = g_object_new (GM_TYPE_APPMENU_MANAGER, NULL);
  manager->display = display;

  return manager;
}

/**
 * gm_appmenu_manager_set_advertised:
 * @self: the manager
 * @advertised: whether clients should see the Wayland global
 *
 * Adds or removes the org_kde_kwin_appmenu_manager global. Menu addresses
 * that clients already announced stay known either way.
 */
void
gm_appmenu_manager_set_advertised (GmAppmenuManager *self,
                                   gboolean          advertised)
{
  g_return_if_fail (GM_IS_APPMENU_MANAGER (self));

  if (advertised && self->global == NULL)
    {
      self->global = wl_global_create (self->display,
                                       &org_kde_kwin_appmenu_manager_interface,
                                       APPMENU_VERSION, self, manager_bind);
    }
  else if (!advertised && self->global != NULL)
    {
      wl_global_destroy (self->global);
      self->global = NULL;
    }
}

/**
 * gm_appmenu_manager_lookup:
 * @self: the manager
 * @window: a #MetaWindow
 * @service_name: (out) (transfer full) (optional): D-Bus name owning the menu
 * @object_path: (out) (transfer full) (optional): object path of the menu
 *
 * Looks up the com.canonical.dbusmenu address the client announced for the
 * surface of @window.
 *
 * Returns: %TRUE if the window has a menu address
 */
gboolean
gm_appmenu_manager_lookup (GmAppmenuManager  *self,
                           GObject           *window,
                           char             **service_name,
                           char             **object_path)
{
  GType window_type = g_type_from_name ("MetaWindow");
  gpointer surface;

  if (service_name != NULL)
    *service_name = NULL;
  if (object_path != NULL)
    *object_path = NULL;

  g_return_val_if_fail (GM_IS_APPMENU_MANAGER (self), FALSE);

  if (window_type == G_TYPE_INVALID || !G_TYPE_CHECK_INSTANCE_TYPE (window, window_type))
    return FALSE;

  surface = meta_window_get_wayland_surface (window);
  if (surface == NULL)
    return FALSE;

  for (GList *l = self->entries; l != NULL; l = l->next)
    {
      Entry *entry = l->data;

      if (entry->surface != surface || entry->service_name == NULL)
        continue;

      if (service_name != NULL)
        *service_name = g_strdup (entry->service_name);
      if (object_path != NULL)
        *object_path = g_strdup (entry->object_path);
      return TRUE;
    }

  return FALSE;
}
