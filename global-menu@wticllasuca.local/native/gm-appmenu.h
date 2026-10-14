/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once

#include <glib-object.h>

G_BEGIN_DECLS

#define GM_TYPE_APPMENU_MANAGER (gm_appmenu_manager_get_type ())
G_DECLARE_FINAL_TYPE (GmAppmenuManager, gm_appmenu_manager, GM, APPMENU_MANAGER, GObject)

GmAppmenuManager *gm_appmenu_manager_get_default    (GObject           *wayland_compositor,
                                                      GError           **error);
void              gm_appmenu_manager_set_advertised (GmAppmenuManager  *self,
                                                      gboolean           advertised);
gboolean          gm_appmenu_manager_lookup         (GmAppmenuManager  *self,
                                                      GObject           *window,
                                                      char             **service_name,
                                                      char             **object_path);

G_END_DECLS
