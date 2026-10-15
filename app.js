
/* =========================================================
   KAS RUANGAN V7
   =========================================================
   V5 BASELINE + V6 + V7

   Storage lama tetap dipertahankan:
   - kasRuangan
   - kasRuanganAnggota
   - kasRuanganIuran
   - kasRuanganIuranAmount

   Backup V5 tetap dapat di-restore.
   ========================================================= */


/* =========================================================
   STORAGE
   ========================================================= */

const TRANSACTION_KEY = "kasRuangan";
const MEMBER_KEY = "kasRuanganAnggota";
const IURAN_KEY = "kasRuanganIuran";
const IURAN_AMOUNT_KEY = "kasRuanganIuranAmount";

const RESET_BACKUP_KEY = "kasRuanganLastResetBackup";
const LAST_BACKUP_KEY = "kasRuanganLastBackup";


/* =========================================================
   SUPABASE ONLINE V1.0
   ========================================================= */

const SUPABASE_URL = "https://brlctambycaatvsnfeqp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJybGN0YW1ieWNhYXR2c25mZXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0NTIzNjgsImV4cCI6MjEwNzAyODM2OH0.hCX13etVsULCrfwx29i_teIEoeZZ2VBplAkMZI2usIQ";

const supabaseClient =
    window.supabase?.createClient
        ? window.supabase.createClient(
            SUPABASE_URL,
            SUPABASE_ANON_KEY,
            {
                auth: {
                    autoRefreshToken: true,
                    persistSession: true,
                    detectSessionInUrl: true
                }
            }
        )
        : null;

let onlineReady = false;
let onlineLoading = false;
let onlineAdminCredentials = null;
let onlineCurrentAuthUser = null;
let onlineSummary = null;
let onlineSummaryLoading = false;
let onlineSyncQueue = Promise.resolve();

function getSupabaseEmail(username) {
    return String(username || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "_") +
        "@medkas.local";
}

function onlineErrorText(error) {
    return error?.message || "Koneksi database online gagal.";
}

async function loadOnlineSummary(year = new Date().getFullYear()) {
    if (!supabaseClient || onlineSummaryLoading) return false;

    onlineSummaryLoading = true;
    try {
        const { data, error } = await supabaseClient.rpc("get_medkas_summary", {
            p_year: Number(year) || new Date().getFullYear()
        });
        if (error) throw error;
        onlineSummary = data || null;
        return !!onlineSummary;
    } catch (error) {
        console.error("MedKas summary:", error);
        showToast("Ringkasan Dashboard/Grafik gagal dimuat: " + onlineErrorText(error));
        return false;
    } finally {
        onlineSummaryLoading = false;
    }
}

async function loadOnlineData() {
    if (!supabaseClient || onlineLoading) return false;

    // Pengguna biasa hanya mengambil agregat melalui RPC. Jangan membaca
    // atau menyimpan rincian anggota, transaksi, dan iuran dari browser.
    if (getCurrentUserRole() === USER_ROLES.USER) {
        onlineLoading = true;
        try {
            transactions = [];
            members = [];
            iuranData = [];
            saveJSON(TRANSACTION_KEY, [], true);
            saveJSON(MEMBER_KEY, [], true);
            saveJSON(IURAN_KEY, [], true);
            const ok = await loadOnlineSummary(new Date().getFullYear());
            if (!ok) throw new Error("Ringkasan tidak tersedia.");
            renderDashboard();
            renderCharts();
            return true;
        } catch (error) {
            console.error("MedKas Online summary:", error);
            showToast("Ringkasan online belum dapat dibaca: " + onlineErrorText(error));
            return false;
        } finally {
            onlineLoading = false;
        }
    }

    onlineLoading = true;

    try {
        const [membersResult, transactionsResult, iuranResult, settingsResult] =
            await Promise.all([
                supabaseClient.from("members").select("*").order("created_at", { ascending: true }),
                supabaseClient.from("transactions").select("*").order("date", { ascending: true }),
                supabaseClient.from("iuran").select("*").order("year", { ascending: true }).order("month", { ascending: true }),
                supabaseClient.from("app_settings").select("*").eq("id", 1).maybeSingle()
            ]);

        const firstError =
            membersResult.error ||
            transactionsResult.error ||
            iuranResult.error ||
            settingsResult.error;

        if (firstError) {
            throw firstError;
        }

        members = (membersResult.data || []).map(row => ({
            id: row.id,
            number: row.number,
            name: row.name,
            position: row.position || "",
            status: row.status || "Aktif",
            note: row.note || ""
        }));

        transactions = (transactionsResult.data || []).map(row => ({
            id: row.id,
            type: row.type,
            date: row.date,
            description: row.description,
            category: row.category,
            amount: Number(row.amount) || 0,
            source: row.source || "",
            isIuran: !!row.is_iuran,
            iuranId: row.iuran_id || "",
            memberId: row.member_id || ""
        }));

        iuranData = (iuranResult.data || []).map(row => ({
            id: row.id,
            memberId: row.member_id,
            month: row.month,
            year: row.year,
            amount: Number(row.amount) || 0,
            status: row.status,
            paidDate: row.paid_date || "",
            transactionId: row.transaction_id || ""
        }));

        if (settingsResult.data) {
            iuranAmount = Number(settingsResult.data.iuran_amount) || 0;
        }

        saveJSON(TRANSACTION_KEY, transactions, true);
        saveJSON(MEMBER_KEY, members, true);
        saveJSON(IURAN_KEY, iuranData, true);
        localStorage.setItem(IURAN_AMOUNT_KEY, String(iuranAmount));

        renderAll();

        return true;

    } catch (error) {
        console.error("MedKas Online:", error);
        showToast("Database online belum dapat dibaca: " + onlineErrorText(error));
        return false;
    } finally {
        onlineLoading = false;
    }
}

async function syncOnlineTable(key, data) {
    if (!onlineReady || !supabaseClient) return true;

    // Akun User hanya boleh melihat Dashboard, Profil, dan Grafik.
    // Jangan kirim perubahan dari localStorage ke tabel server saat role User.
    // Data tampilan tetap dimuat oleh loadOnlineData() dengan skipOnline=true.
    if (getCurrentUserRole() === USER_ROLES.USER) {
        return true;
    }

    try {
        if (key === MEMBER_KEY) {
            const rows = (Array.isArray(data) ? data : []).map(m => ({
                id: String(m.id),
                number: String(m.number || ""),
                name: String(m.name || ""),
                position: String(m.position || ""),
                status: normalizeStatus(m.status),
                note: String(m.note || "")
            }));

            if (rows.length) {
                const { error } = await supabaseClient
                    .from("members")
                    .upsert(rows, { onConflict: "id" });
                if (error) throw error;
            }

            // Keamanan: tidak menghapus data server berdasarkan perbandingan dengan data lokal.
        }

        if (key === IURAN_KEY) {
            /*
               iuran.transaction_id dan transactions.iuran_id saling
               berelasi. Simpan iuran lebih dahulu dengan transaction_id
               NULL. Relasi akan dilengkapi setelah transaksi tersimpan.
            */
            const rows = (Array.isArray(data) ? data : []).map(r => ({
                id: String(r.id),
                member_id: String(r.memberId || ""),
                month: Number(r.month),
                year: Number(r.year),
                amount: Number(r.amount) || 0,
                status: getIuranStatus(r),
                paid_date: r.paidDate || null,
                transaction_id: null
            }));

            if (rows.length) {
                const { error } = await supabaseClient
                    .from("iuran")
                    .upsert(rows, { onConflict: "id" });
                if (error) throw error;
            }

            // Keamanan: tidak menghapus data server berdasarkan perbandingan dengan data lokal.
        }

        if (key === TRANSACTION_KEY) {
            /*
               Pastikan seluruh iuran yang direferensikan sudah ada dahulu.
               Ini diperlukan karena transactions.iuran_id adalah FK ke iuran.
            */
            const iuranRows = (Array.isArray(iuranData) ? iuranData : []).map(r => ({
                id: String(r.id),
                member_id: String(r.memberId || ""),
                month: Number(r.month),
                year: Number(r.year),
                amount: Number(r.amount) || 0,
                status: getIuranStatus(r),
                paid_date: r.paidDate || null,
                transaction_id: null
            }));

            if (iuranRows.length) {
                const { error } = await supabaseClient
                    .from("iuran")
                    .upsert(iuranRows, { onConflict: "id" });
                if (error) throw error;
            }

            const rows = (Array.isArray(data) ? data : []).map(t => ({
                id: String(t.id),
                type: t.type,
                date: t.date,
                description: String(t.description || ""),
                category: String(t.category || ""),
                amount: Number(t.amount) || 0,
                source: t.source || null,
                is_iuran: !!t.isIuran,
                iuran_id: t.iuranId || null,
                member_id: t.memberId || null
            }));

            if (rows.length) {
                const { error } = await supabaseClient
                    .from("transactions")
                    .upsert(rows, { onConflict: "id" });
                if (error) throw error;
            }

            /* Lengkapi FK iuran.transaction_id setelah transaksi ada. */
            for (const r of (Array.isArray(data) ? data : [])) {
                if (!r.iuranId || !r.id) continue;

                const { error } = await supabaseClient
                    .from("iuran")
                    .update({ transaction_id: String(r.id) })
                    .eq("id", String(r.iuranId));
                if (error) throw error;
            }

            // Keamanan: tidak menghapus data server berdasarkan perbandingan dengan data lokal.
        }

        if (key === IURAN_AMOUNT_KEY) {
            const { error } = await supabaseClient
                .from("app_settings")
                .update({ iuran_amount: Number(iuranAmount) || 0 })
                .eq("id", 1);
            if (error) throw error;
        }

        return true;
    } catch (error) {
        console.error("Sinkronisasi MedKas gagal:", error);
        showToast("Perubahan belum tersimpan ke server: " + onlineErrorText(error));
        return false;
    }
}

function startOnlineSync(key, data) {
    if (!onlineReady || !supabaseClient) return;

    /* Jalankan sinkronisasi berurutan agar iuran selalu dibuat
       sebelum transaksi yang mereferensikannya. */
    onlineSyncQueue = onlineSyncQueue
        .catch(() => undefined)
        .then(() => syncOnlineTable(key, data));
}

async function loadOnlineProfile(authUser) {
    if (!supabaseClient || !authUser) return null;

    const { data, error } = await supabaseClient
        .from("user_profiles")
        .select("*")
        .eq("id", authUser.id)
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

function cacheOnlineProfile(profile) {
    if (!profile) return null;

    const user = {
        id: profile.id,
        username: profile.username || String(profile.id).slice(0, 8),
        name: profile.full_name || "Pengguna",
        memberId: profile.member_id || "",
        role: profile.role || USER_ROLES.USER,
        status: profile.status || "active",
        protected: !!profile.protected,
        lastLogin: profile.last_login || null,
        createdAt: profile.created_at || new Date().toISOString()
    };

    const users = getManagedUsers();
    const index = users.findIndex(item => String(item.id) === String(user.id));

    if (index >= 0) users[index] = { ...users[index], ...user };
    else users.push(user);

    saveJSON(USER_MANAGEMENT_KEY, users, true);
    localStorage.setItem(CURRENT_USER_KEY, user.username);
    localStorage.setItem(LOGIN_USERNAME_KEY, user.username);
    localStorage.setItem(LOGIN_SESSION_KEY, "true");

    return user;
}

async function finishOnlineLogin(authUser, profile) {
    onlineCurrentAuthUser = authUser;
    onlineReady = true;
    cacheOnlineProfile(profile);
    hideLoginScreen();
    updateRoleBasedMenu();
    await loadOnlineData();
    updateRoleBasedMenu();
}

/* =========================================================
   USER MANAGEMENT V9
   ========================================================= */

const USER_MANAGEMENT_KEY = "kasRuanganUsersV9";
const CURRENT_USER_KEY = "kasRuanganCurrentUserV9";

const USER_ROLES = {
    ADMIN: "admin",
    BENDAHARA: "bendahara",
    USER: "user"
};


/* =========================================================
   DEFAULT ADMIN V9
   ========================================================= */

function initializeDefaultAdmin() {

    let users =
        loadJSON(
            USER_MANAGEMENT_KEY,
            null
        );

    /*
       Jika database user V9 belum ada,
       buat akun Admin dari login V8 yang sedang aktif.
    */

    if (!Array.isArray(users) || !users.length) {

        users = [
            {
                id:
                    "admin-" +
                    Date.now(),

                username:
                    getLoginUsername
                        ? getLoginUsername()
                        : "admin",

                name:
                    "Administrator",

                password:
                    getLoginPassword
                        ? getLoginPassword()
                        : "admin123",

                role:
                    USER_ROLES.ADMIN,

                status:
                    "active",

                protected:
                    true,

                lastLogin:
                    null,

                createdAt:
                    new Date().toISOString()
            }
        ];

        saveJSON(
            USER_MANAGEMENT_KEY,
            users
        );
    }

    /*
       Pastikan selalu ada Admin utama.
    */

    const protectedAdmin =
        users.find(
            user =>
                user.protected === true
        );

    if (!protectedAdmin) {

        users.unshift({

            id:
                "admin-" +
                Date.now(),

            username:
                getLoginUsername
                    ? getLoginUsername()
                    : "admin",

            name:
                "Administrator",

            password:
                getLoginPassword
                    ? getLoginPassword()
                    : "admin123",

            role:
                USER_ROLES.ADMIN,

            status:
                "active",

            protected:
                true,

            lastLogin:
                null,

            createdAt:
                new Date().toISOString()

        });

        saveJSON(
            USER_MANAGEMENT_KEY,
            users
        );
    }

}


/* =========================================================
   USER DATABASE
   ========================================================= */

function getManagedUsers() {

    const users =
        loadJSON(
            USER_MANAGEMENT_KEY,
            []
        );

    return Array.isArray(users)
        ? users
        : [];
}


function saveManagedUsers(users) {

    saveJSON(
        USER_MANAGEMENT_KEY,
        users
    );

}


function getCurrentManagedUser() {

    const username =
        localStorage.getItem(
            CURRENT_USER_KEY
        );

    if (!username) {
        return null;
    }

    return getManagedUsers().find(
        user =>
            user.username === username
    ) || null;
}



function getCurrentUserRole() {
    const user = getCurrentManagedUser();

    return user?.role ||
        USER_ROLES.USER;
}

function isCurrentUserAdmin() {

    return (
        getCurrentUserRole() ===
        USER_ROLES.ADMIN
    );

}


function getRoleLabel(role) {

    const labels = {

        admin:
            "👑 Admin",

        bendahara:
            "💰 Bendahara",

        user:
            "👤 User"

    };

    return (
        labels[role] ||
        "👤 User"
    );

}


function getUserStatusLabel(status) {

    return status === "active"
        ? "🟢 Aktif"
        : "🔴 Nonaktif";

}


function formatUserLoginDate(date) {

    if (!date) {
        return "-";
    }

    const d =
        new Date(date);

    if (
        Number.isNaN(
            d.getTime()
        )
    ) {
        return "-";
    }

    return d.toLocaleString(
        "id-ID"
    );

}


/* =========================================================
   LOAD DATA
   ========================================================= */

function loadJSON(key, fallback) {

    try {

        const value = localStorage.getItem(key);

        if (!value) {
            return fallback;
        }

        const parsed = JSON.parse(value);

        return parsed ?? fallback;

    } catch (error) {

        console.error("Gagal membaca:", key, error);

        return fallback;
    }
}


function saveJSON(key, data, skipOnline = false) {

    try {

        localStorage.setItem(
            key,
            JSON.stringify(data)
        );

        if (!skipOnline) {
            startOnlineSync(key, data);
        }

        return true;

    } catch (error) {

        console.error("Gagal menyimpan:", key, error);

        alert(
            "Gagal menyimpan data. " +
            "Kemungkinan penyimpanan browser penuh."
        );

        return false;
    }
}


let transactions =
    loadJSON(TRANSACTION_KEY, []);

let members =
    loadJSON(MEMBER_KEY, []);

let iuranData =
    loadJSON(IURAN_KEY, []);

let iuranAmount =
    Number(
        localStorage.getItem(IURAN_AMOUNT_KEY) || 10000
    );


/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function uid(prefix = "id") {

    if (onlineReady && crypto?.randomUUID) {
        return crypto.randomUUID();
    }

    return (
        prefix +
        "_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2, 9)
    );
}


function formatRupiah(value) {

    const number = Number(value) || 0;

    return new Intl.NumberFormat(
        "id-ID",
        {
            style: "currency",
            currency: "IDR",
            maximumFractionDigits: 0
        }
    ).format(number);
}


function today() {

    const d = new Date();

    const y = d.getFullYear();
    const m = String(
        d.getMonth() + 1
    ).padStart(2, "0");

    const day = String(
        d.getDate()
    ).padStart(2, "0");

    return `${y}-${m}-${day}`;
}


function formatDate(value) {

    if (!value) return "-";

    const d = new Date(value + "T00:00:00");

    if (Number.isNaN(d.getTime())) {
        return value;
    }

    return d.toLocaleDateString(
        "id-ID",
        {
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
        }
    );
}


function escapeHTML(value) {

    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function getElement(id) {
    return document.getElementById(id);
}


/* =========================================================
   RENDER USER MANAGEMENT
   ========================================================= */

async function syncManagedUsersFromSupabase() {
    // Ambil profil yang sudah ada di server agar akun yang dibuat sebelumnya
    // (misalnya Febri) ikut muncul pada daftar Pengguna.
    if (!supabaseClient || !onlineCurrentAuthUser || !isCurrentUserAdmin()) return;

    try {
        const { data, error } = await supabaseClient
            .from("user_profiles")
            .select("id, username, full_name, member_id, role, status, protected, last_login, created_at")
            .order("created_at", { ascending: true });

        if (error) throw error;

        const localUsers = getManagedUsers();
        const byId = new Map(localUsers.map(user => [String(user.id), user]));

        for (const profile of (data || [])) {
            if (!profile?.id) continue;
            const normalized = {
                id: profile.id,
                username: profile.username || String(profile.id).slice(0, 8),
                name: profile.full_name || "Pengguna",
                memberId: profile.member_id || "",
                role: profile.role || USER_ROLES.USER,
                status: profile.status || "active",
                protected: !!profile.protected,
                lastLogin: profile.last_login || null,
                createdAt: profile.created_at || new Date().toISOString()
            };
            byId.set(String(normalized.id), { ...(byId.get(String(normalized.id)) || {}), ...normalized });
        }

        saveManagedUsers(Array.from(byId.values()));
        renderUserManagement();
    } catch (error) {
        console.error("Gagal menyinkronkan daftar pengguna dari Supabase:", error);
        showToast("Daftar pengguna server belum bisa dimuat: " + onlineErrorText(error));
    }
}

function renderUserManagement() {

    const tbody =
        getElement(
            "userManagementTableBody"
        );

    if (!tbody) {
        return;
    }

    const users =
        getManagedUsers();

    if (!isCurrentUserAdmin()) {

        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="empty-state">
                        <div>🔒</div>
                        Anda tidak memiliki akses ke halaman ini.
                    </div>
                </td>
            </tr>
        `;

        return;
    }

    if (!users.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="empty-state">
                        <div>👥</div>
                        Belum ada pengguna.
                    </div>
                </td>
            </tr>
        `;

        return;
    }

    tbody.innerHTML =
        users.map(
            (user, index) => {

                const roleClass =
                    user.role === "admin"
                        ? "user-role-admin"
                        : user.role === "bendahara"
                            ? "user-role-bendahara"
                            : "user-role-user";

                const statusClass =
                    user.status === "active"
                        ? "user-status-active"
                        : "user-status-inactive";

                return `
                    <tr>

                        <td>
                            ${index + 1}
                        </td>

                        <td>
                            <strong>
                                ${escapeHTML(
                                    user.username
                                )}
                            </strong>
                        </td>

                        <td>
                            ${escapeHTML(
                                user.name || "-"
                            )}
                        </td>

                        <td>
                            <span class="
                                user-role-badge
                                ${roleClass}
                            ">
                                ${escapeHTML(
                                    getRoleLabel(
                                        user.role
                                    )
                                )}
                            </span>
                        </td>

                        <td>
                            <span class="
                                user-status-badge
                                ${statusClass}
                            ">
                                ${escapeHTML(
                                    getUserStatusLabel(
                                        user.status
                                    )
                                )}
                            </span>
                        </td>

                        <td>
                            ${formatUserLoginDate(
                                user.lastLogin
                            )}
                        </td>

                        <td>

                            <div class="user-action-buttons">

                                <button
                                    type="button"
                                    title="Edit pengguna"
                                    onclick="openUserManagementModalById('${user.id}')"
                                >
                                    ✏️
                                </button>

                                ${
                                    user.protected
                                        ? ""
                                        : `
                                            <button
                                                type="button"
                                                title="${
                                                    user.status === "active"
                                                        ? "Nonaktifkan"
                                                        : "Aktifkan"
                                                }"
                                                onclick="toggleManagedUser('${user.id}')"
                                            >
                                                ${
                                                    user.status === "active"
                                                        ? "🔴"
                                                        : "🟢"
                                                }
                                            </button>

                                            <button
                                                type="button"
                                                title="Hapus pengguna"
                                                onclick="deleteManagedUser('${user.id}')"
                                            >
                                                🗑️
                                            </button>
                                        `
                                }

                            </div>

                        </td>

                    </tr>
                `;

            }
        ).join("");

}


/* =========================================================
   USER MODAL V9
   ========================================================= */

/*
   Daftar Nama Anggota untuk akun pengguna.
   Sumbernya selalu dari panel Anggota.
*/
function populateUserMemberOptions(selectedMemberId = "", selectedName = "") {

    const select =
        getElement("userFullName");

    if (!select) {
        return;
    }

    const currentValue =
        String(selectedMemberId || "");

    const membersList =
        [...members]
            .filter(member => member && member.name)
            .sort((a, b) =>
                String(a.name).localeCompare(
                    String(b.name),
                    "id-ID",
                    { sensitivity: "base" }
                )
            );

    select.innerHTML =
        `<option value="">Pilih nama anggota...</option>`;

    membersList.forEach(member => {

        const option =
            document.createElement("option");

        option.value = String(member.id);

        option.textContent =
            member.number
                ? `${member.name} — ${member.number}`
                : member.name;

        option.dataset.memberName =
            member.name;

        select.appendChild(option);
    });

    /*
       Kompatibilitas akun lama: jika akun belum mempunyai
       memberId tetapi namanya cocok dengan panel Anggota,
       otomatis pilih anggota yang cocok.
    */
    if (!currentValue && selectedName) {

        const match =
            membersList.find(member =>
                String(member.name).trim().toLowerCase() ===
                String(selectedName).trim().toLowerCase()
            );

        if (match) {
            select.value = String(match.id);
            return;
        }
    }

    if (currentValue) {
        select.value = currentValue;
    }
}


function getSelectedUserMember() {

    const select =
        getElement("userFullName");

    if (!select || !select.value) {
        return null;
    }

    const member =
        members.find(
            item =>
                String(item.id) ===
                String(select.value)
        );

    if (member) {
        return member;
    }

    const option =
        select.selectedOptions?.[0];

    if (option?.dataset.memberName) {
        return {
            id: "",
            name: option.dataset.memberName
        };
    }

    return null;
}


function openUserManagementModal(user = null) {

    if (!isCurrentUserAdmin()) {

        showToast(
            "Hanya Admin yang dapat mengelola pengguna."
        );

        return;
    }

    const modal =
        getElement(
            "userManagementModal"
        );

    const title =
        getElement(
            "userModalTitle"
        );

    const editingId =
        getElement(
            "editingUserId"
        );

    const username =
        getElement(
            "userUsername"
        );

    const fullName =
        getElement(
            "userFullName"
        );

    const password =
        getElement(
            "userPassword"
        );

    const role =
        getElement(
            "userRole"
        );

    const status =
        getElement(
            "userStatus"
        );

    if (!modal) {
        return;
    }

    populateUserMemberOptions(
        user?.memberId || "",
        user?.name || ""
    );

    /* Admin utama lama bukan anggota panel, jadi tetap
       tersedia sebagai pilihan khusus agar akun utama tidak rusak. */
    if (user?.protected && fullName && !fullName.value) {

        const option =
            document.createElement("option");

        option.value = "__protected_admin__";
        option.textContent = user.name || "Administrator";
        option.dataset.memberName = user.name || "Administrator";
        fullName.appendChild(option);
        fullName.value = option.value;
    }

    if (user) {

        if (title) {
            title.textContent =
                "Edit Pengguna";
        }

        if (editingId) {
            editingId.value =
                user.id;
        }

        if (username) {
            username.value =
                user.username;
            username.readOnly =
                user.protected;
        }

        if (fullName && user.memberId) {
            fullName.value =
                String(user.memberId);
        }

        if (password) {
            password.value = "";
        }

        if (role) {
            role.value =
                user.role;
        }

        if (status) {
            status.value =
                user.status;
        }

        /*
           Admin utama tidak boleh
           diturunkan role-nya.
        */

        if (user.protected) {

            if (role) {
                role.value =
                    USER_ROLES.ADMIN;
                role.disabled = true;
            }

            if (status) {
                status.value =
                    "active";
                status.disabled = true;
            }

        } else {

            if (role) {
                role.disabled = false;
            }

            if (status) {
                status.disabled = false;
            }

        }

    } else {

        if (title) {
            title.textContent =
                "Tambah Pengguna";
        }

        if (editingId) {
            editingId.value = "";
        }

        if (username) {
            username.value = "";
            username.readOnly = false;
        }

        if (fullName) {
            fullName.value = "";
        }

        if (password) {
            password.value = "";
        }

        if (role) {
            role.value =
                USER_ROLES.USER;
            role.disabled = false;
        }

        if (status) {
            status.value = "active";
            status.disabled = false;
        }

    }

    modal.classList.add("show");

    modal.setAttribute(
        "aria-hidden",
        "false"
    );

}


function openUserManagementModalById(id) {

    const user =
        getManagedUsers().find(
            item =>
                item.id === id
        );

    if (!user) {
        return;
    }

    openUserManagementModal(
        user
    );

}


function closeUserManagementModal() {

    const modal =
        getElement(
            "userManagementModal"
        );

    if (!modal) {
        return;
    }

    modal.classList.remove(
        "show"
    );

    modal.setAttribute(
        "aria-hidden",
        "true"
    );

}


async function saveManagedUser(event) {
    event.preventDefault();

    if (!isCurrentUserAdmin()) {
        showToast("Hanya Admin yang dapat menyimpan pengguna.");
        return;
    }

    if (!supabaseClient || !onlineCurrentAuthUser) {
        showToast("Koneksi Supabase belum siap.");
        return;
    }

    const editingId =
        getElement("editingUserId")?.value.trim() || "";

    const username =
        getElement("userUsername")?.value.trim() || "";

    const selectedMember =
        getSelectedUserMember();

    const memberId =
        selectedMember?.id || "";

    const name =
        selectedMember?.name?.trim() || "";

    const password =
        getElement("userPassword")?.value || "";

    const role =
        getElement("userRole")?.value || USER_ROLES.USER;

    const status =
        getElement("userStatus")?.value || "active";

    // ==============================
    // VALIDASI DASAR
    // ==============================

    if (!username) {
        showToast("Username tidak boleh kosong.");
        return;
    }

    if (!name) {
        showToast("Nama pengguna tidak boleh kosong.");
        return;
    }

    if (!editingId && password.length < 6) {
        showToast("Password minimal 6 karakter.");
        return;
    }

    if (editingId && password && password.length < 6) {
        showToast("Password minimal 6 karakter.");
        return;
    }

    // ==============================
    // CEK USERNAME LOKAL
    // ==============================

    const users = getManagedUsers();

    const duplicate =
        users.find(
            user =>
                String(user.username || "").toLowerCase() ===
                    username.toLowerCase() &&
                user.id !== editingId
        );

    if (duplicate) {
        showToast("Username sudah digunakan.");
        return;
    }

    // ==============================
    // TAMBAH USER BARU
    // ==============================

    if (!editingId) {

        try {

            showToast("Sedang membuat akun pengguna...");
console.log("ONLINE AUTH USER:", onlineCurrentAuthUser);

const { data: authCheck } =
    await supabaseClient.auth.getUser();

console.log("SUPABASE AUTH USER:", authCheck?.user);
            const { data: sessionData } =
    await supabaseClient.auth.getSession();

const accessToken =
    sessionData?.session?.access_token;

if (!accessToken) {
    showToast("Session login Supabase tidak ditemukan. Silakan login ulang.");
    return;
}

const response = await fetch(
    `${SUPABASE_URL}/functions/v1/hyper-responder`,
    {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
            "apikey": SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
            username,
            full_name: name,
            member_id: memberId,
            role,
            status,
            password
        })
    }
);

const data = await response.json();

console.log("CREATE USER RESPONSE:", data);

if (!response.ok) {
    console.error("EDGE FUNCTION ERROR:", data);

    showToast(
        data?.error ||
        data?.message ||
        `Edge Function error (${response.status})`
    );

    return;
}
            // Tidak memakai `if (error)` di sini karena request
            // menggunakan fetch(), bukan supabase.functions.invoke().
            // Kegagalan fetch sudah ditangani oleh try/catch dan
            // respons HTTP gagal ditangani oleh pemeriksaan response.ok.
            // ==============================
            // SIMPAN CACHE LOKAL
            // TANPA PASSWORD
            // ==============================

            const createdUser =
                data?.user?.profile ||
                data?.profile ||
                data?.user_profile ||
                null;

            if (!createdUser || !createdUser.id) {
                console.error(
                    "Profil pengguna tidak ditemukan pada respons Edge Function:",
                    data
                );
                showToast(
                    "Akun mungkin sudah dibuat, tetapi profil tidak terbaca. Periksa Console dan respons Edge Function."
                );
                return;
            }

            // Hindari duplikat cache bila profil sudah ada.
            const existingIndex = users.findIndex(
                item => String(item.id) === String(createdUser.id)
            );

            const normalizedUser = {
                id: createdUser.id,
                username: createdUser.username || username,
                name: createdUser.full_name || name,
                memberId: createdUser.member_id || memberId,
                role: createdUser.role || role,
                status: createdUser.status || status,
                protected: !!createdUser.protected,
                lastLogin: createdUser.last_login || null,
                createdAt:
                    createdUser.created_at ||
                    new Date().toISOString()
            };

            if (existingIndex >= 0) {
                users[existingIndex] = {
                    ...users[existingIndex],
                    ...normalizedUser
                };
            } else {
                users.push(normalizedUser);
            }

            saveManagedUsers(users);

            closeUserManagementModal();
            renderUserManagement();

            showToast(
                "Pengguna berhasil ditambahkan ke Supabase."
            );

        } catch (error) {

            console.error(
                "Gagal membuat pengguna:",
                error
            );

            showToast(
                error?.message ||
                "Terjadi kesalahan saat membuat pengguna."
            );
        }

        return;
    }

    // ==============================
    // EDIT USER
    // ==============================

    const user =
        users.find(
            item =>
                item.id === editingId
        );

    if (!user) {
        showToast("Pengguna tidak ditemukan.");
        return;
    }

    // Untuk sementara protected admin tidak boleh
    // diubah role/statusnya.
    if (user.protected) {
        user.username = username;
        user.name = name;
        user.memberId = memberId;
        user.role = USER_ROLES.ADMIN;
        user.status = "active";
    } else {
        user.username = username;
        user.name = name;
        user.memberId = memberId;
        user.role = role;
        user.status = status;
    }

    // Simpan perubahan ke Supabase agar tautan akun <-> anggota berlaku
    // di semua perangkat, bukan hanya di browser admin.
    try {
        const profileUpdate = {
            username,
            full_name: name,
            member_id: memberId || null,
            role: user.protected ? USER_ROLES.ADMIN : role,
            status: user.protected ? "active" : status,
            updated_at: new Date().toISOString()
        };

        const { data: updatedProfile, error: updateError } = await supabaseClient
            .from("user_profiles")
            .update(profileUpdate)
            .eq("id", editingId)
            .select("id, username, full_name, member_id, role, status, protected, last_login, created_at")
            .maybeSingle();

        if (updateError) throw updateError;
        if (!updatedProfile) {
            throw new Error("Profil tidak diperbarui. Pastikan kebijakan UPDATE user_profiles mengizinkan Admin.");
        }

        user.username = updatedProfile.username || username;
        user.name = updatedProfile.full_name || name;
        user.memberId = updatedProfile.member_id || "";
        user.role = updatedProfile.role || role;
        user.status = updatedProfile.status || status;
        user.protected = !!updatedProfile.protected;
        user.lastLogin = updatedProfile.last_login || user.lastLogin || null;

        saveManagedUsers(users);
        closeUserManagementModal();
        renderUserManagement();

        showToast("Akun berhasil diperbarui dan terhubung ke anggota di Supabase.");
    } catch (error) {
        console.error("Gagal memperbarui profil pengguna di Supabase:", error);
        showToast("Gagal menyimpan perubahan ke server: " + onlineErrorText(error));
    }
}

function toggleManagedUser(id) {

    if (!isCurrentUserAdmin()) {

        showToast(
            "Hanya Admin yang dapat mengubah status pengguna."
        );

        return;
    }

    const users =
        getManagedUsers();

    const user =
        users.find(
            item =>
                item.id === id
        );

    if (!user) {
        return;
    }

    if (user.protected) {

        showToast(
            "Admin utama tidak dapat dinonaktifkan."
        );

        return;
    }

    const newStatus =
        user.status === "active"
            ? "inactive"
            : "active";

    const actionText =
        newStatus === "active"
            ? "mengaktifkan"
            : "menonaktifkan";

    if (
        !confirm(
            `Yakin ingin ${actionText} pengguna "${user.username}"?`
        )
    ) {
        return;
    }

    user.status =
        newStatus;

    saveManagedUsers(
        users
    );

    renderUserManagement();

    showToast(
        newStatus === "active"
            ? "Pengguna berhasil diaktifkan."
            : "Pengguna berhasil dinonaktifkan."
    );

}


function deleteManagedUser(id) {

    if (!isCurrentUserAdmin()) {

        showToast(
            "Hanya Admin yang dapat menghapus pengguna."
        );

        return;
    }

    const users =
        getManagedUsers();

    const user =
        users.find(
            item =>
                item.id === id
        );

    if (!user) {
        return;
    }

    if (user.protected) {

        showToast(
            "Admin utama tidak dapat dihapus."
        );

        return;
    }

    if (
        !confirm(
            `Hapus pengguna "${user.username}"?`
        )
    ) {
        return;
    }

    const filtered =
        users.filter(
            item =>
                item.id !== id
        );

    saveManagedUsers(
        filtered
    );

    renderUserManagement();

    showToast(
        "Pengguna berhasil dihapus."
    );

}


/* =========================================================
   INITIALIZE USER MANAGEMENT V9
   ========================================================= */

function initializeUserManagement() {

    initializeDefaultAdmin();

    getElement(
        "btnTambahPengguna"
    )?.addEventListener(
        "click",
        () =>
            openUserManagementModal()
    );

    getElement(
        "btnCloseUserModal"
    )?.addEventListener(
        "click",
        closeUserManagementModal
    );

    getElement(
        "btnCancelUserModal"
    )?.addEventListener(
        "click",
        closeUserManagementModal
    );

    getElement(
        "userManagementForm"
    )?.addEventListener(
        "submit",
        saveManagedUser
    );

    getElement(
        "userManagementModal"
    )?.addEventListener(
        "click",
        event => {

            if (
                event.target.id ===
                "userManagementModal"
            ) {

                closeUserManagementModal();

            }

        }
    );

}



/* =========================================================
   ROLE ACCESS V9
   ========================================================= */

function getAllowedPagesForCurrentUser() {

    const role = getCurrentUserRole();

    if (role === USER_ROLES.USER) {
        return ["dashboard", "profil", "grafik"];
    }

    if (role === USER_ROLES.ADMIN) {
        return [
            "dashboard", "anggota", "pemasukan", "pengeluaran",
            "iuran", "laporan", "rekap", "grafik", "keamanan",
            "pengguna", "profil"
        ];
    }

    // Bendahara tetap dapat menjalankan operasional, tetapi tidak mengelola pengguna.
    return [
        "dashboard", "anggota", "pemasukan", "pengeluaran",
        "iuran", "laporan", "rekap", "grafik", "keamanan", "profil"
    ];
}


function updateRoleBasedMenu() {

    const allowedPages = getAllowedPagesForCurrentUser();

    document.querySelectorAll(".menu").forEach(menu => {
        menu.style.display =
            allowedPages.includes(menu.dataset.page) ? "" : "none";
    });

    const role = getCurrentUserRole();
    const isUser = role === USER_ROLES.USER;
    const isAdmin = role === USER_ROLES.ADMIN;
    const backupBtn = getElement("backupBtn");
    const restoreLabel = document.querySelector(".restore-label");

    if (backupBtn) backupBtn.style.display = isUser ? "none" : "";
    if (restoreLabel) restoreLabel.style.display = isAdmin ? "" : "none";

    // Reset/Undo Reset hanya boleh digunakan oleh Admin.
    document.querySelectorAll(
        '[onclick*="openResetModal"], [onclick*="undoLastReset"]'
    ).forEach(button => {
        button.style.display = isAdmin ? "" : "none";
    });
}


function enforceAdminPageAccess(page) {

    const allowedPages = getAllowedPagesForCurrentUser();

    if (!allowedPages.includes(page)) {
        showToast(
            getCurrentUserRole() === USER_ROLES.USER
                ? "Akun User hanya dapat mengakses Dashboard, Profil Saya, dan Grafik."
                : "Halaman ini tidak dapat diakses oleh akun Anda."
        );
        return false;
    }

    return true;
}


function showToast(message) {

    const toast = getElement("toast");

    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(
        showToast.timer
    );

    showToast.timer = setTimeout(() => {

        toast.classList.remove("show");

    }, 3000);
}


/* =========================================================
   NORMALIZE MEMBERS
   ========================================================= */

function normalizeStatus(status) {

    const value =
        String(status ?? "")
            .trim()
            .toLowerCase();

    if (
        !value ||
        value === "aktif" ||
        value === "active"
    ) {
        return "Aktif";
    }

    if (
        value === "tidak aktif" ||
        value === "inactive" ||
        value === "nonaktif"
    ) {
        return "Tidak Aktif";
    }

    return status || "Aktif";
}


function normalizeMembers() {

    members = members.map((m, index) => {

        return {

            id:
                m.id ??
                m.ID ??
                m.memberId ??
                uid("member"),

            number:
                m.number ??
                m.nomor ??
                m.no ??
                m.noAnggota ??
                m.memberNumber ??
                "",

            name:
                m.name ??
                m.nama ??
                m.namaAnggota ??
                "",

            position:
                m.position ??
                m.jabatan ??
                "",

            status:
                normalizeStatus(
                    m.status
                ),

            note:
                m.note ??
                m.keterangan ??
                ""
        };

    });

    saveJSON(
        MEMBER_KEY,
        members
    );
}


/* =========================================================
   NORMALIZE TRANSACTIONS
   ========================================================= */

function normalizeTransactions() {

    let changed = false;

    transactions = transactions.map(t => {

        const item = {
            ...t
        };

        if (!item.id) {
            item.id = uid("trx");
            changed = true;
        }

        if (!item.type) {
            item.type =
                item.jenis ??
                item.transactionType ??
                "Pemasukan";

            changed = true;
        }

        if (!item.date) {
            item.date =
                item.tanggal ??
                today();

            changed = true;
        }

        if (!item.description) {
            item.description =
                item.keterangan ??
                item.description ??
                "-";

            changed = true;
        }

        if (!item.category) {
            item.category =
                item.kategori ??
                (
                    item.type === "Pemasukan"
                        ? "Pemasukan Manual"
                        : "Pengeluaran Umum"
                );

            changed = true;
        }

        const amount =
            Number(
                item.amount ??
                item.jumlah ??
                item.nominal ??
                0
            );

        if (item.amount !== amount) {
            changed = true;
        }

        item.amount = amount;

        if (
            item.type === "pemasukan" ||
            item.type === "INCOME"
        ) {
            item.type = "Pemasukan";
            changed = true;
        }

        if (
            item.type === "pengeluaran" ||
            item.type === "EXPENSE"
        ) {
            item.type = "Pengeluaran";
            changed = true;
        }

        return item;

    });

    if (changed) {
        saveJSON(
            TRANSACTION_KEY,
            transactions
        );
    }
}


/* =========================================================
   NORMALIZE IURAN
   ========================================================= */

function normalizeIuranData() {

    let changed = false;

    iuranData = iuranData.map(item => {

        const r = {
            ...item
        };

        if (!r.id) {
            r.id = uid("iuran");
            changed = true;
        }

        if (!r.memberId) {

            r.memberId =
                r.anggotaId ??
                r.memberID ??
                r.idAnggota ??
                "";

            changed = true;
        }

        if (!r.month) {

            r.month =
                Number(
                    r.bulan ??
                    r.monthNumber ??
                    0
                );

            changed = true;
        }

        if (!r.year) {

            r.year =
                Number(
                    r.tahun ??
                    new Date().getFullYear()
                );

            changed = true;
        }

        if (!r.amount) {

            r.amount =
                Number(
                    r.jumlah ??
                    iuranAmount
                );

            changed = true;
        }

        if (!r.status) {

            r.status =
                r.paid
                    ? "LUNAS"
                    : "LUNAS";

            changed = true;
        }

        return r;

    });

    if (changed) {

        saveJSON(
            IURAN_KEY,
            iuranData
        );
    }
}


/* =========================================================
   ACTIVE MEMBERS
   ========================================================= */

function getActiveMembers() {

    return members.filter(
        m =>
            !m.status ||
            normalizeStatus(m.status) === "Aktif"
    );
}


/* =========================================================
   TRANSACTION TOTALS
   ========================================================= */

function getIncomeTotal() {

    return transactions
        .filter(
            t => t.type === "Pemasukan"
        )
        .reduce(
            (sum, t) =>
                sum + Number(t.amount || 0),
            0
        );
}


function getExpenseTotal() {

    return transactions
        .filter(
            t => t.type === "Pengeluaran"
        )
        .reduce(
            (sum, t) =>
                sum + Number(t.amount || 0),
            0
        );
}


function isIuranTransaction(t) {

    return Boolean(
        t.isIuran ||
        t.source === "Iuran" ||
        t.category === "Iuran" ||
        t.iuranId
    );
}


function getIuranIncomeTotal() {

    return transactions
        .filter(
            t =>
                t.type === "Pemasukan" &&
                isIuranTransaction(t)
        )
        .reduce(
            (sum, t) =>
                sum + Number(t.amount || 0),
            0
        );
}


function getManualIncomeTotal() {

    return getIncomeTotal()
        - getIuranIncomeTotal();
}


function getBalance() {

    return (
        getIncomeTotal() -
        getExpenseTotal()
    );
}


/* =========================================================
   DATE FILTER
   ========================================================= */

function inDateRange(
    date,
    start,
    end
) {

    if (!date) return false;

    if (start && date < start) {
        return false;
    }

    if (end && date > end) {
        return false;
    }

    return true;
}


function getYearFromDate(date) {

    if (!date) return null;

    const match =
        String(date).match(/^(\d{4})-/);

    return match
        ? Number(match[1])
        : null;
}


function getMonthFromDate(date) {

    if (!date) return null;

    const match =
        String(date).match(
            /^\d{4}-(\d{2})-/
        );

    return match
        ? Number(match[1])
        : null;
}


/* =========================================================
   PROFIL SAYA
   ========================================================= */

function getCurrentProfileMember() {

    const user =
        getCurrentManagedUser();

    if (!user) {
        return null;
    }

    /* Utamakan hubungan berdasarkan ID anggota. */
    if (user.memberId) {

        const byId =
            members.find(
                member =>
                    String(member.id) ===
                    String(user.memberId)
            );

        if (byId) {
            return byId;
        }
    }

    /* Kompatibilitas akun lama yang belum mempunyai memberId. */
    if (user.name) {

        return members.find(
            member =>
                String(member.name || "")
                    .trim()
                    .toLowerCase() ===
                String(user.name || "")
                    .trim()
                    .toLowerCase()
        ) || null;
    }

    return null;
}


function getProfileMonthKey(year, month) {

    return `${year}-${String(month).padStart(2, "0")}`;
}


function getEarliestIuranPeriod() {

    const periods =
        iuranData
            .map(record => getIuranPeriod(record))
            .filter(
                period =>
                    Number(period.year) > 0 &&
                    Number(period.month) >= 1 &&
                    Number(period.month) <= 12
            )
            .map(period => ({
                year: Number(period.year),
                month: Number(period.month)
            }));

    if (!periods.length) {
        return null;
    }

    periods.sort(
        (a, b) =>
            a.year - b.year ||
            a.month - b.month
    );

    return periods[0];
}


function getProfileIuranSummary(memberId) {

    if (!memberId) {
        return {
            paidMonths: 0,
            unpaidMonths: 0,
            totalMonths: 0,
            outstanding: 0,
            unpaidPeriods: [],
            hasData: false
        };
    }

    const earliest =
        getEarliestIuranPeriod();

    if (!earliest) {
        return {
            paidMonths: 0,
            unpaidMonths: 0,
            totalMonths: 0,
            outstanding: 0,
            unpaidPeriods: [],
            hasData: false
        };
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    let year = earliest.year;
    let month = earliest.month;

    let paidMonths = 0;
    let unpaidMonths = 0;
    let totalMonths = 0;
    let outstanding = 0;
    const unpaidPeriods = [];

    while (
        year < currentYear ||
        (year === currentYear && month <= currentMonth)
    ) {

        totalMonths++;

        const record =
            getIuranRecord(
                memberId,
                month,
                year
            );

        const paid =
            Boolean(
                record &&
                getIuranStatus(record) === "LUNAS"
            );

        if (paid) {
            paidMonths++;
        } else {
            unpaidMonths++;
            outstanding += Number(iuranAmount) || 0;

            unpaidPeriods.push({
                year,
                month,
                key: getProfileMonthKey(year, month)
            });
        }

        month++;

        if (month > 12) {
            month = 1;
            year++;
        }
    }

    return {
        paidMonths,
        unpaidMonths,
        totalMonths,
        outstanding,
        unpaidPeriods,
        hasData: true
    };
}


async function renderMyProfileOnline() {
    const tableBody = getElement("profileUnpaidTableBody");
    const statusElement = getElement("profileIuranStatus");
    if (statusElement) statusElement.textContent = "Memuat profil dan tunggakan...";
    if (tableBody) tableBody.innerHTML = `<tr><td colspan="3">Memuat data...</td></tr>`;

    try {
        const { data, error } = await supabaseClient.rpc("get_my_profile_summary");
        if (error) throw error;
        const d = data || {};
        const put = (id, value) => {
            const el = getElement(id);
            if (el) el.textContent = value == null || value === "" ? "-" : String(value);
        };
        put("profileUserName", d.fullName || d.username || "Pengguna");
        put("profileUsername", `@${d.username || "-"}`);
        put("profileRole", getRoleLabel(d.role || "user"));
        put("profileMemberNumber", d.memberNumber || "-");
        put("profileMemberName", d.memberName || "Belum terhubung ke anggota");
        put("profilePosition", d.position || "-");
        put("profilePaidMonths", Number(d.paidMonths) || 0);
        put("profileUnpaidMonths", Number(d.unpaidMonths) || 0);
        put("profileOutstanding", formatRupiah(Number(d.outstanding) || 0));

        if (statusElement) {
            statusElement.textContent = !d.linked
                ? "Akun belum terhubung ke data Anggota. Hubungkan akun dengan anggota di menu Kelola Pengguna."
                : !d.hasData
                    ? "Belum ada data iuran untuk menghitung tunggakan."
                    : Number(d.unpaidMonths) === 0
                        ? "✅ Tidak ada tunggakan iuran."
                        : `⚠️ Ada ${Number(d.unpaidMonths) || 0} bulan tunggakan.`;
        }

        if (!tableBody) return;
        const periods = Array.isArray(d.unpaidPeriods) ? d.unpaidPeriods : [];
        if (!d.linked) {
            tableBody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div>🔗</div>Akun ini belum terhubung dengan anggota.</div></td></tr>`;
        } else if (!d.hasData) {
            tableBody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div>🪙</div>Belum ada data iuran.</div></td></tr>`;
        } else if (!periods.length) {
            tableBody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div>🎉</div>Semua iuran tercatat lunas.</div></td></tr>`;
        } else {
            tableBody.innerHTML = periods.map(period => {
                const month = Number(period.month) || 1;
                const year = Number(period.year) || new Date().getFullYear();
                return `<tr><td>${monthNames[month - 1] || month}</td><td>${year}</td><td><strong>${formatRupiah(Number(period.amount ?? d.iuranAmount) || 0)}</strong></td></tr>`;
            }).join("");
        }
    } catch (error) {
        console.error("Gagal memuat profil online:", error);
        if (statusElement) statusElement.textContent = "Profil/tunggakan gagal dimuat: " + onlineErrorText(error);
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="3">Data profil gagal dimuat. Periksa fungsi get_my_profile_summary di Supabase.</td></tr>`;
    }
}


function renderMyProfile() {

    if (getCurrentUserRole() === USER_ROLES.USER && onlineReady && supabaseClient) {
        void renderMyProfileOnline();
        return;
    }

    const user =
        getCurrentManagedUser();

    const member =
        getCurrentProfileMember();

    const nameElement =
        getElement("profileUserName");

    const usernameElement =
        getElement("profileUsername");

    const roleElement =
        getElement("profileRole");

    const memberNumberElement =
        getElement("profileMemberNumber");

    const memberNameElement =
        getElement("profileMemberName");

    const positionElement =
        getElement("profilePosition");

    const paidElement =
        getElement("profilePaidMonths");

    const unpaidElement =
        getElement("profileUnpaidMonths");

    const totalElement =
        getElement("profileOutstanding");

    const statusElement =
        getElement("profileIuranStatus");

    const tableBody =
        getElement("profileUnpaidTableBody");

    if (!user) {
        return;
    }

    if (nameElement) {
        nameElement.textContent =
            member?.name ||
            user.name ||
            "Pengguna";
    }

    if (usernameElement) {
        usernameElement.textContent =
            `@${user.username}`;
    }

    if (roleElement) {
        roleElement.textContent =
            getRoleLabel(user.role);
    }

    if (memberNumberElement) {
        memberNumberElement.textContent =
            member?.number || "-";
    }

    if (memberNameElement) {
        memberNameElement.textContent =
            member?.name || "Belum terhubung ke anggota";
    }

    if (positionElement) {
        positionElement.textContent =
            member?.position || "-";
    }

    const summary =
        getProfileIuranSummary(
            member?.id
        );

    if (paidElement) {
        paidElement.textContent =
            summary.paidMonths;
    }

    if (unpaidElement) {
        unpaidElement.textContent =
            summary.unpaidMonths;
    }

    if (totalElement) {
        totalElement.textContent =
            formatRupiah(summary.outstanding);
    }

    if (statusElement) {
        if (!member) {
            statusElement.textContent =
                "Akun belum terhubung ke data Anggota.";
        } else if (!summary.hasData) {
            statusElement.textContent =
                "Belum ada data iuran untuk menghitung tunggakan.";
        } else if (summary.unpaidMonths === 0) {
            statusElement.textContent =
                "✅ Tidak ada tunggakan iuran.";
        } else {
            statusElement.textContent =
                `⚠️ Ada ${summary.unpaidMonths} bulan tunggakan.`;
        }
    }

    if (!tableBody) {
        return;
    }

    if (!member) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="3">
                    <div class="empty-state">
                        <div>🔗</div>
                        Akun ini belum terhubung dengan anggota.
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    if (!summary.hasData) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="3">
                    <div class="empty-state">
                        <div>🪙</div>
                        Belum ada data iuran.
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    if (!summary.unpaidPeriods.length) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="3">
                    <div class="empty-state">
                        <div>🎉</div>
                        Semua iuran tercatat lunas.
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tableBody.innerHTML =
        summary.unpaidPeriods
            .map(period => {

                const monthName =
                    monthNames[period.month - 1] ||
                    period.month;

                return `
                    <tr>
                        <td>${monthName}</td>
                        <td>${period.year}</td>
                        <td>
                            <strong>
                                ${formatRupiah(iuranAmount)}
                            </strong>
                        </td>
                    </tr>
                `;
            })
            .join("");
}


/* =========================================================
   NAVIGATION
   ========================================================= */

const pageTitles = {

    dashboard: [
        "Dashboard",
        "Ringkasan keuangan ruangan"
    ],

    anggota: [
        "Anggota",
        "Data anggota ruangan"
    ],

    pemasukan: [
        "Pemasukan",
        "Catatan pemasukan kas"
    ],

    pengeluaran: [
        "Pengeluaran",
        "Catatan pengeluaran kas"
    ],

    iuran: [
        "Iuran",
        "Pembayaran iuran anggota"
    ],

    laporan: [
        "Laporan",
        "Laporan keuangan"
    ],

    rekap: [
        "Rekap",
        "Rekapitulasi bulanan"
    ],

    grafik: [
        "Grafik",
        "Visualisasi keuangan"
    ],

    keamanan: [
        "Data & Backup",
        "Backup, restore dan reset data"
    ],

    pengguna: [
        "Kelola Pengguna",
        "Kelola akun dan hak akses pengguna."
    ],

    profil: [
        "Profil Saya",
        "Informasi akun dan status iuran pribadi."
    ]

};


function showPage(page) {

    // Setiap berpindah halaman, kembali ke posisi paling atas agar
    // isi halaman tidak tampak terpotong karena posisi scroll halaman sebelumnya.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    if (!enforceAdminPageAccess(page)) {
        page = "dashboard";
    }

    document
        .querySelectorAll(".page")
        .forEach(section => {

            section.classList.toggle(
                "active",
                section.id ===
                `page-${page}`
            );

        });

    document
        .querySelectorAll(".menu")
        .forEach(menu => {

            menu.classList.toggle(
                "active",
                menu.dataset.page === page
            );

        });

    const title =
        pageTitles[page] ||
        ["MedKas", ""];

    if (getElement("pageTitle")) {
        getElement("pageTitle").textContent =
            title[0];
    }

    if (getElement("pageSubtitle")) {
        getElement("pageSubtitle").textContent =
            title[1];
    }

    if (page === "dashboard") {
        renderDashboard();
    }

    if (page === "anggota") {
        renderMembers();
    }

    if (page === "pemasukan") {
        renderIncome();
    }

    if (page === "pengeluaran") {
        renderExpenses();
    }

    if (page === "iuran") {
        renderIuran();
    }

    if (page === "laporan") {
        renderReport();
    }

    if (page === "rekap") {
        renderRecap();
    }

    if (page === "grafik") {
        renderCharts();
    }

    if (page === "keamanan") {
        updateSafetyInfo();
    }

    if (page === "pengguna") {
        renderUserManagement();
        void syncManagedUsersFromSupabase();
    }

    if (page === "profil") {
        renderMyProfile();
    }
}


document
    .querySelectorAll(".menu")
    .forEach(menu => {

        menu.addEventListener(
            "click",
            () => {

                showPage(
                    menu.dataset.page
                );

            }
        );

    });


/* =========================================================
   SIDEBAR AUTO-HIDE / HAMBURGER
   ========================================================= */

(function initializeSidebarController() {

    const sidebar = document.querySelector(".sidebar");
    const toggle = document.getElementById("sidebarToggle");

    if (!sidebar || !toggle) return;

    let closeTimer = null;

    function setSidebar(open) {
        document.body.classList.toggle("sidebar-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? "Tutup menu" : "Buka menu");
    }

    function scheduleClose() {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (!sidebar.matches(":hover") && !toggle.matches(":hover")) {
                setSidebar(false);
            }
        }, 700);
    }

    toggle.addEventListener("click", () => {
        setSidebar(!document.body.classList.contains("sidebar-open"));
    });

    sidebar.addEventListener("mouseenter", () => {
        clearTimeout(closeTimer);
        setSidebar(true);
    });

    sidebar.addEventListener("mouseleave", scheduleClose);

    document.addEventListener("mousemove", event => {
        // Menyentuhkan mouse ke sisi paling kiri layar membuka menu.
        if (window.innerWidth > 800 && event.clientX <= 8) {
            clearTimeout(closeTimer);
            setSidebar(true);
        }
    });

    // Klik menu tetap membuka halaman, lalu sidebar otomatis menutup.
    document.querySelectorAll(".sidebar .menu").forEach(menu => {
        menu.addEventListener("click", () => {
            if (window.innerWidth > 800) scheduleClose();
        });
    });

    // Desktop dimulai dalam keadaan tersembunyi.
    if (window.innerWidth > 800) {
        setSidebar(false);
    } else {
        setSidebar(true);
    }

})();


/* =========================================================
   DASHBOARD
   ========================================================= */

function renderDashboard() {

    if (getCurrentUserRole() === USER_ROLES.USER && onlineSummary) {
        const now = new Date();
        const setText = (id, value) => {
            const el = getElement(id);
            if (el) el.textContent = value;
        };
        setText("dashboardBalance", formatRupiah(Number(onlineSummary.balance) || 0));
        setText("dashboardIncome", formatRupiah(Number(onlineSummary.income) || 0));
        setText("dashboardExpense", formatRupiah(Number(onlineSummary.expense) || 0));
        setText("dashboardMembers", Number(onlineSummary.activeMembers) || 0);
        setText("dashboardIuran", formatRupiah(Number(onlineSummary.iuranPaid) || 0));
        setText("dashboardUnpaid", Number(onlineSummary.iuranUnpaid) || 0);
        setText("dashboardManualIncome", formatRupiah(Number(onlineSummary.manualIncome) || 0));
        setText("dashboardIuranIncome", formatRupiah(Math.max(0, (Number(onlineSummary.income) || 0) - (Number(onlineSummary.manualIncome) || 0))));
        setText("dashboardTransactions", (onlineSummary.monthly || []).reduce((total, row) => total + (Number(row.transactions) || 0), 0));
        setText("dashboardCurrentMonth", now.toLocaleDateString("id-ID", { month: "long", year: "numeric" }));
        setText("dashboardMonthIncome", formatRupiah(Number(onlineSummary.monthIncome) || 0));
        setText("dashboardMonthExpense", formatRupiah(Number(onlineSummary.monthExpense) || 0));
        setText("dashboardMonthBalance", formatRupiah((Number(onlineSummary.monthIncome) || 0) - (Number(onlineSummary.monthExpense) || 0)));
        setText("dashboardMonthUnpaid", Number(onlineSummary.iuranUnpaid) || 0);
        const activity = getElement("dashboardActivity");
        if (activity) activity.innerHTML = '<div class="empty-state"><div>🔒</div>Rincian transaksi hanya tersedia untuk Admin dan Bendahara.</div>';
        return;
    }

    const now = new Date();

    const month =
        now.getMonth() + 1;

    const year =
        now.getFullYear();

    const monthText =
        now.toLocaleDateString(
            "id-ID",
            {
                month: "long",
                year: "numeric"
            }
        );

    const monthPrefix =
        `${year}-${String(month).padStart(2, "0")}`;

    const monthTransactions =
        transactions.filter(
            t =>
                String(t.date || "")
                    .startsWith(monthPrefix)
        );

    const monthIncome =
        monthTransactions
            .filter(
                t => t.type === "Pemasukan"
            )
            .reduce(
                (s, t) =>
                    s + Number(t.amount || 0),
                0
            );

    const monthExpense =
        monthTransactions
            .filter(
                t => t.type === "Pengeluaran"
            )
            .reduce(
                (s, t) =>
                    s + Number(t.amount || 0),
                0
            );

    const summary =
        getIuranSummary(
            month,
            year
        );

    getElement("dashboardBalance")
        .textContent =
        formatRupiah(
            getBalance()
        );

    getElement("dashboardIncome")
        .textContent =
        formatRupiah(
            getIncomeTotal()
        );

    getElement("dashboardExpense")
        .textContent =
        formatRupiah(
            getExpenseTotal()
        );

    getElement("dashboardMembers")
        .textContent =
        getActiveMembers().length;

    getElement("dashboardIuran")
        .textContent =
        formatRupiah(
            summary.paidTotal
        );

    getElement("dashboardUnpaid")
        .textContent =
        summary.unpaidCount;

    getElement("dashboardManualIncome")
        .textContent =
        formatRupiah(
            getManualIncomeTotal()
        );

    getElement("dashboardIuranIncome")
        .textContent =
        formatRupiah(
            getIuranIncomeTotal()
        );

    getElement("dashboardTransactions")
        .textContent =
        transactions.length;

    getElement("dashboardCurrentMonth")
        .textContent =
        monthText;

    getElement("dashboardMonthIncome")
        .textContent =
        formatRupiah(
            monthIncome
        );

    getElement("dashboardMonthExpense")
        .textContent =
        formatRupiah(
            monthExpense
        );

    getElement("dashboardMonthBalance")
        .textContent =
        formatRupiah(
            monthIncome -
            monthExpense
        );

    getElement("dashboardMonthUnpaid")
        .textContent =
        summary.unpaidCount;

    renderDashboardActivity();
}


function renderDashboardActivity() {

    const container =
        getElement("dashboardActivity");

    if (!container) return;

    const list =
        [...transactions]
            .sort(
                (a, b) =>
                    String(b.date || "")
                        .localeCompare(
                            String(a.date || "")
                        )
            )
            .slice(0, 8);

    if (!list.length) {

        container.innerHTML = `
            <div class="empty-state">
                <div>🧾</div>
                Belum ada transaksi.
            </div>
        `;

        return;
    }

    container.innerHTML =
        list.map(t => {

            const income =
                t.type === "Pemasukan";

            return `
                <div class="activity-item">

                    <div class="activity-main">

                        <strong>
                            ${escapeHTML(
                                t.description
                            )}
                        </strong>

                        <small>
                            ${formatDate(t.date)}
                            ·
                            ${escapeHTML(
                                t.category || "-"
                            )}
                        </small>

                    </div>

                    <div class="
                        activity-amount
                        ${income
                            ? "income-text"
                            : "expense-text"}
                    ">
                        ${income ? "+" : "-"}
                        ${formatRupiah(
                            t.amount
                        )}
                    </div>

                </div>
            `;

        }).join("");
}


/* =========================================================
   MEMBERS
   ========================================================= */

function openMemberModal(id = "") {

    const modal =
        getElement("memberModal");

    const form =
        getElement("memberForm");

    form.reset();

    getElement("memberId")
        .value = "";

    getElement("memberModalTitle")
        .textContent =
        id
            ? "Edit Anggota"
            : "Tambah Anggota";

    if (id) {

        const member =
            members.find(
                m => String(m.id) === String(id)
            );

        if (!member) return;

        getElement("memberId")
            .value = member.id;

        getElement("memberNumber")
            .value = member.number;

        getElement("memberName")
            .value = member.name;

        getElement("memberPosition")
            .value = member.position;

        getElement("memberStatus")
            .value =
            normalizeStatus(
                member.status
            );

        getElement("memberNote")
            .value = member.note;
    }

    modal.classList.add("show");
}


function closeMemberModal() {

    getElement("memberModal")
        .classList.remove("show");
}


function saveMember(event) {

    event.preventDefault();

    const id =
        getElement("memberId").value.trim();

    const number =
        getElement("memberNumber")
            .value.trim();

    const name =
        getElement("memberName")
            .value.trim();

    if (!number || !name) {

        alert(
            "Nomor dan nama anggota wajib diisi."
        );

        return;
    }

    const data = {

        id:
            id ||
            uid("member"),

        number,

        name,

        position:
            getElement("memberPosition")
                .value.trim(),

        status:
            normalizeStatus(
                getElement("memberStatus")
                    .value
            ),

        note:
            getElement("memberNote")
                .value.trim()
    };

    if (id) {

        const index =
            members.findIndex(
                m =>
                    String(m.id) ===
                    String(id)
            );

        if (index >= 0) {
            members[index] = data;
        }

    } else {

        members.push(data);

    }

    saveJSON(
        MEMBER_KEY,
        members
    );

    closeMemberModal();

    renderAll();

    showToast(
        id
            ? "Anggota berhasil diperbarui."
            : "Anggota berhasil ditambahkan."
    );
}


function deleteMember(id) {

    const used =
        transactions.some(
            t =>
                String(t.memberId || "") ===
                String(id)
        ) ||
        iuranData.some(
            r =>
                String(r.memberId || "") ===
                String(id)
        );

    if (used) {

        alert(
            "Anggota tidak dapat dihapus karena masih digunakan dalam data transaksi atau iuran."
        );

        return;
    }

    if (
        !confirm(
            "Hapus anggota ini?"
        )
    ) {
        return;
    }

    members =
        members.filter(
            m =>
                String(m.id) !==
                String(id)
        );

    saveJSON(
        MEMBER_KEY,
        members
    );

    renderAll();

    showToast(
        "Anggota berhasil dihapus."
    );
}


function renderMembers() {

    const table =
        getElement("memberTable");

    if (!table) return;

    const tbody =
        table.querySelector("tbody");

    const search =
        (
            getElement("memberSearch")
                ?.value || ""
        )
            .trim()
            .toLowerCase();

    const status =
        getElement("memberStatusFilter")
            ?.value || "";

    const filtered =
        members.filter(m => {

            const text =
                [
                    m.number,
                    m.name,
                    m.position,
                    m.note
                ]
                    .join(" ")
                    .toLowerCase();

            const matchSearch =
                !search ||
                text.includes(search);

            const matchStatus =
                !status ||
                normalizeStatus(m.status) ===
                status;

            return (
                matchSearch &&
                matchStatus
            );
        });

    if (!filtered.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="empty-state">
                        <div>👥</div>
                        Data anggota tidak ditemukan.
                    </div>
                </td>
            </tr>
        `;

        return;
    }

    tbody.innerHTML =
        filtered.map(
            (m, index) => {

                const active =
                    normalizeStatus(
                        m.status
                    ) === "Aktif";

                return `
                    <tr>

                        <td>${index + 1}</td>

                        <td>
                            ${escapeHTML(
                                m.number
                            )}
                        </td>

                        <td>
                            <strong>
                                ${escapeHTML(
                                    m.name
                                )}
                            </strong>
                        </td>

                        <td>
                            ${escapeHTML(
                                m.position || "-"
                            )}
                        </td>

                        <td>
                            <span class="
                                badge
                                ${active
                                    ? "badge-success"
                                    : "badge-danger"}
                            ">
                                ${escapeHTML(
                                    normalizeStatus(
                                        m.status
                                    )
                                )}
                            </span>
                        </td>

                        <td>
                            ${escapeHTML(
                                m.note || "-"
                            )}
                        </td>

                        <td>

                            <button
                                class="table-action edit"
                                onclick="openMemberModal('${m.id}')">
                                ✏️
                            </button>

                            <button
                                class="table-action delete"
                                onclick="deleteMember('${m.id}')">
                                🗑️
                            </button>

                        </td>

                    </tr>
                `;

            }
        ).join("");
}


/* =========================================================
   TRANSACTIONS
   ========================================================= */

function openTransactionModal(
    type,
    id = ""
) {

    const modal =
        getElement("transactionModal");

    const form =
        getElement("transactionForm");

    form.reset();

    getElement("transactionId")
        .value = "";

    getElement("transactionType")
        .value = type;

    getElement("transactionDate")
        .value = today();

    getElement("transactionCategory")
        .value =
        type === "Pemasukan"
            ? "Pemasukan Manual"
            : "Pengeluaran Umum";

    getElement("transactionModalTitle")
        .textContent =
        id
            ? `Edit ${type}`
            : `Tambah ${type}`;

    if (id) {

        const transaction =
            transactions.find(
                t =>
                    String(t.id) ===
                    String(id)
            );

        if (!transaction) return;

        if (isIuranTransaction(transaction)) {

            alert(
                "Transaksi iuran dikelola dari menu Iuran."
            );

            return;
        }

        getElement("transactionId")
            .value = transaction.id;

        getElement("transactionType")
            .value = transaction.type;

        getElement("transactionDate")
            .value = transaction.date;

        getElement("transactionDescription")
            .value =
            transaction.description;

        getElement("transactionCategory")
            .value =
            transaction.category;

        getElement("transactionAmount")
            .value =
            transaction.amount;
    }

    modal.classList.add("show");
}


function closeTransactionModal() {

    getElement("transactionModal")
        .classList.remove("show");
}


function saveTransaction(event) {

    event.preventDefault();

    const id =
        getElement("transactionId")
            .value.trim();

    const type =
        getElement("transactionType")
            .value;

    const date =
        getElement("transactionDate")
            .value;

    const description =
        getElement("transactionDescription")
            .value.trim();

    const category =
        getElement("transactionCategory")
            .value.trim();

    const amount =
        Number(
            getElement("transactionAmount")
                .value
        );

    if (
        !date ||
        !description ||
        !category ||
        amount <= 0
    ) {

        alert(
            "Lengkapi data transaksi dengan benar."
        );

        return;
    }

    const data = {

        id:
            id ||
            uid("trx"),

        type,

        date,

        description,

        category,

        amount

    };

    if (id) {

        const index =
            transactions.findIndex(
                t =>
                    String(t.id) ===
                    String(id)
            );

        if (index >= 0) {
            transactions[index] = {
                ...transactions[index],
                ...data
            };
        }

    } else {

        transactions.push(data);

    }

    saveJSON(
        TRANSACTION_KEY,
        transactions
    );

    closeTransactionModal();

    renderAll();

    showToast(
        id
            ? "Transaksi berhasil diperbarui."
            : "Transaksi berhasil ditambahkan."
    );
}


function deleteTransaction(id) {

    const transaction =
        transactions.find(
            t =>
                String(t.id) ===
                String(id)
        );

    if (!transaction) return;

    if (
        isIuranTransaction(
            transaction
        )
    ) {

        alert(
            "Transaksi iuran harus dihapus dari menu Iuran."
        );

        return;
    }

    if (
        !confirm(
            "Hapus transaksi ini?"
        )
    ) {
        return;
    }

    transactions =
        transactions.filter(
            t =>
                String(t.id) !==
                String(id)
        );

    saveJSON(
        TRANSACTION_KEY,
        transactions
    );

    renderAll();

    showToast(
        "Transaksi berhasil dihapus."
    );
}


/* =========================================================
   CATEGORY FILTER
   ========================================================= */

function populateCategoryFilters() {

    const incomeSelect =
        getElement(
            "incomeCategoryFilter"
        );

    const expenseSelect =
        getElement(
            "expenseCategoryFilter"
        );

    const incomeCategories =
        [
            ...new Set(
                transactions
                    .filter(
                        t =>
                            t.type ===
                            "Pemasukan"
                    )
                    .map(
                        t =>
                            t.category ||
                            "Tanpa Kategori"
                    )
            )
        ]
            .sort();

    const expenseCategories =
        [
            ...new Set(
                transactions
                    .filter(
                        t =>
                            t.type ===
                            "Pengeluaran"
                    )
                    .map(
                        t =>
                            t.category ||
                            "Tanpa Kategori"
                    )
            )
        ]
            .sort();

    const fill = (
        select,
        categories
    ) => {

        if (!select) return;

        const old =
            select.value;

        select.innerHTML =
            `<option value="">
                Semua Kategori
            </option>`;

        categories.forEach(
            category => {

                const option =
                    document.createElement(
                        "option"
                    );

                option.value =
                    category;

                option.textContent =
                    category;

                select.appendChild(
                    option
                );
            }
        );

        if (
            categories.includes(old)
        ) {
            select.value = old;
        }
    };

    fill(
        incomeSelect,
        incomeCategories
    );

    fill(
        expenseSelect,
        expenseCategories
    );
}


/* =========================================================
   INCOME
   ========================================================= */

function renderIncome() {

    populateCategoryFilters();

    const tbody =
        getElement("incomeTable")
            ?.querySelector("tbody");

    if (!tbody) return;

    const search =
        (
            getElement("incomeSearch")
                ?.value || ""
        )
            .trim()
            .toLowerCase();

    const filter =
        getElement("incomeFilter")
            ?.value || "";

    const start =
        getElement("incomeStartDate")
            ?.value || "";

    const end =
        getElement("incomeEndDate")
            ?.value || "";

    const category =
        getElement(
            "incomeCategoryFilter"
        )?.value || "";

    const filtered =
        transactions
            .filter(
                t =>
                    t.type ===
                    "Pemasukan"
            )
            .filter(t => {

                const text =
                    [
                        t.description,
                        t.category
                    ]
                        .join(" ")
                        .toLowerCase();

                const matchSearch =
                    !search ||
                    text.includes(search);

                const matchFilter =
                    !filter ||
                    (
                        filter === "iuran" &&
                        isIuranTransaction(t)
                    ) ||
                    (
                        filter === "manual" &&
                        !isIuranTransaction(t)
                    );

                const matchDate =
                    inDateRange(
                        t.date,
                        start,
                        end
                    );

                const matchCategory =
                    !category ||
                    t.category ===
                    category;

                return (
                    matchSearch &&
                    matchFilter &&
                    matchDate &&
                    matchCategory
                );
            })
            .sort(
                (a, b) =>
                    String(b.date)
                        .localeCompare(
                            String(a.date)
                        )
            );

    getElement("incomeTotal")
        .textContent =
        formatRupiah(
            getIncomeTotal()
        );

    getElement("manualIncomeTotal")
        .textContent =
        formatRupiah(
            getManualIncomeTotal()
        );

    getElement("iuranIncomeTotal")
        .textContent =
        formatRupiah(
            getIuranIncomeTotal()
        );

    if (!filtered.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="empty-state">
                        <div>💰</div>
                        Tidak ada pemasukan.
                    </div>
                </td>
            </tr>
        `;

        return;
    }

    tbody.innerHTML =
        filtered.map(t => {

            const iuran =
                isIuranTransaction(t);

            return `
                <tr>

                    <td>${formatDate(t.date)}</td>

                    <td>
                        ${escapeHTML(
                            t.description
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            t.category || "-"
                        )}
                    </td>

                    <td>
                        <span class="
                            badge
                            ${iuran
                                ? "badge-blue"
                                : "badge-success"}
                        ">
                            ${iuran
                                ? "Iuran"
                                : "Manual"}
                        </span>
                    </td>

                    <td>
                        <strong>
                            ${formatRupiah(
                                t.amount
                            )}
                        </strong>
                    </td>

                    <td>

                        ${
                            iuran
                                ? `
                                    <span
                                        class="badge badge-blue">
                                        🔒
                                    </span>
                                  `
                                : `
                                    <button
                                        class="table-action edit"
                                        onclick="openTransactionModal(
                                            'Pemasukan',
                                            '${t.id}'
                                        )">
                                        ✏️
                                    </button>

                                    <button
                                        class="table-action delete"
                                        onclick="deleteTransaction(
                                            '${t.id}'
                                        )">
                                        🗑️
                                    </button>
                                  `
                        }

                    </td>

                </tr>
            `;

        }).join("");
}


/* =========================================================
   EXPENSE
   ========================================================= */

function renderExpenses() {

    populateCategoryFilters();

    const tbody =
        getElement("expenseTable")
            ?.querySelector("tbody");

    if (!tbody) return;

    const search =
        (
            getElement("expenseSearch")
                ?.value || ""
        )
            .trim()
            .toLowerCase();

    const start =
        getElement("expenseStartDate")
            ?.value || "";

    const end =
        getElement("expenseEndDate")
            ?.value || "";

    const category =
        getElement(
            "expenseCategoryFilter"
        )?.value || "";

    const filtered =
        transactions
            .filter(
                t =>
                    t.type ===
                    "Pengeluaran"
            )
            .filter(t => {

                const text =
                    [
                        t.description,
                        t.category
                    ]
                        .join(" ")
                        .toLowerCase();

                return (
                    (!search ||
                        text.includes(search)) &&

                    inDateRange(
                        t.date,
                        start,
                        end
                    ) &&

                    (
                        !category ||
                        t.category ===
                        category
                    )
                );
            })
            .sort(
                (a, b) =>
                    String(b.date)
                        .localeCompare(
                            String(a.date)
                        )
            );

    const expenseTotal =
        getElement("expenseTotal");

    if (expenseTotal) {

        expenseTotal.textContent =
            formatRupiah(
                getExpenseTotal()
            );

    }

    if (!filtered.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="5">
                    <div class="empty-state">
                        <div>💸</div>
                        Tidak ada pengeluaran.
                    </div>
                </td>
            </tr>
        `;

        return;
    }

    tbody.innerHTML =
        filtered.map(t => {

            return `
                <tr>

                    <td>${formatDate(t.date)}</td>

                    <td>
                        ${escapeHTML(
                            t.description
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            t.category || "-"
                        )}
                    </td>

                    <td>
                        <strong>
                            ${formatRupiah(
                                t.amount
                            )}
                        </strong>
                    </td>

                    <td>

                        <button
                            class="table-action edit"
                            onclick="openTransactionModal(
                                'Pengeluaran',
                                '${t.id}'
                            )">
                            ✏️
                        </button>

                        <button
                            class="table-action delete"
                            onclick="deleteTransaction(
                                '${t.id}'
                            )">
                            🗑️
                        </button>

                    </td>

                </tr>
            `;

        }).join("");
}


/* =========================================================
   IURAN
   ========================================================= */

const monthNames = [

    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember"

];


function getIuranPeriod(record) {

    return {

        month:
            Number(
                record?.month ??
                record?.bulan ??
                0
            ),

        year:
            Number(
                record?.year ??
                record?.tahun ??
                0
            )

    };
}


/* ---------------------------------------------------------
   V8: STATUS IURAN DINORMALISASI
   --------------------------------------------------------- */

function getIuranStatus(record) {

    if (!record) {
        return "";
    }

    return String(
        record.status ??
        record.statusIuran ??
        ""
    )
        .trim()
        .toUpperCase();
}


/* ---------------------------------------------------------
   V8: MEMBER ID LEBIH TAHAN DATA LAMA
   --------------------------------------------------------- */

function getIuranMemberId(record) {

    if (!record) {
        return "";
    }

    return String(
        record.memberId ??
        record.memberID ??
        record.anggotaId ??
        record.anggotaID ??
        ""
    );
}


function getIuranRecord(
    memberId,
    month,
    year
) {

    return iuranData.find(
        record => {

            const p =
                getIuranPeriod(
                    record
                );

            return (

                getIuranMemberId(
                    record
                ) ===
                String(memberId) &&

                p.month ===
                Number(month) &&

                p.year ===
                Number(year)

            );

        }
    );
}


function getIuranSummary(
    month,
    year
) {

    const active =
        getActiveMembers();

    let paidTotal = 0;
    let unpaidCount = 0;

    active.forEach(member => {

        const record =
            getIuranRecord(
                member.id,
                month,
                year
            );

        if (
            record &&
            getIuranStatus(record) ===
            "LUNAS"
        ) {

            const recordAmount =
                Number(record.amount);

            paidTotal +=
                Number.isFinite(
                    recordAmount
                ) &&
                recordAmount > 0
                    ? recordAmount
                    : Number(iuranAmount);

        } else {

            unpaidCount++;

        }

    });

    return {

        paidTotal,

        unpaidCount,

        outstanding:
            active.reduce((total, member) => {
                const record = getIuranRecord(member.id, month, year);
                if (record && getIuranStatus(record) === "LUNAS") return total;
                const recordAmount = Number(record?.amount);
                const amount = Number.isFinite(recordAmount) && recordAmount > 0
                    ? recordAmount
                    : Number(iuranAmount);
                return total + (Number.isFinite(amount) && amount > 0 ? amount : 0);
            }, 0)

    };
}


function initializeIuranControls() {

    const monthSelect =
        getElement("iuranMonth");

    const yearSelect =
        getElement("iuranYear");

    if (!monthSelect || !yearSelect) {
        return;
    }

    const oldMonth =
        monthSelect.value;

    const oldYear =
        yearSelect.value;

    monthSelect.innerHTML =
        monthNames.map(
            (name, index) =>
                `<option value="${index + 1}">
                    ${name}
                </option>`
        ).join("");

    const currentYear =
        new Date().getFullYear();

    const years = [];

    for (
        let y = currentYear - 3;
        y <= currentYear + 3;
        y++
    ) {
        years.push(y);
    }

    yearSelect.innerHTML =
        years.map(
            y =>
                `<option value="${y}">
                    ${y}
                </option>`
        ).join("");

    const now =
        new Date();

    monthSelect.value =
        monthNames
            .map(
                (_, index) =>
                    String(index + 1)
            )
            .includes(oldMonth)
                ? oldMonth
                : String(
                    now.getMonth() + 1
                );

    yearSelect.value =
        years
            .map(String)
            .includes(oldYear)
                ? oldYear
                : String(
                    now.getFullYear()
                );

    const amountElement =
        getElement("iuranAmount");

    if (amountElement) {

        amountElement.value =
            iuranAmount;

    }
}


function saveIuranAmount() {

    const amountElement =
        getElement("iuranAmount");

    if (!amountElement) {
        return;
    }

    const amount =
        Number(
            amountElement.value
        );

    if (
        !Number.isFinite(amount) ||
        amount < 0
    ) {

        alert(
            "Nominal iuran tidak valid."
        );

        return;
    }

    iuranAmount = amount;

    localStorage.setItem(
        IURAN_AMOUNT_KEY,
        String(iuranAmount)
    );

    renderIuran();

    showToast(
        "Nominal iuran berhasil disimpan."
    );
}


function renderIuran() {

    const tbody =
        getElement("iuranTable")
            ?.querySelector("tbody");

    if (!tbody) return;

    const month =
        Number(
            getElement("iuranMonth")
                ?.value
        );

    const year =
        Number(
            getElement("iuranYear")
                ?.value
        );

    const search =
        (
            getElement("iuranSearch")
                ?.value || ""
        )
            .trim()
            .toLowerCase();

    const statusFilter =
        getElement("iuranStatusFilter")
            ?.value || "";

    const active =
        getActiveMembers();

    const summary =
        getIuranSummary(
            month,
            year
        );

    const paidTotal =
        getElement("iuranPaidTotal");

    if (paidTotal) {

        paidTotal.textContent =
            formatRupiah(
                summary.paidTotal
            );

    }

    const outstanding =
        getElement("iuranOutstanding");

    if (outstanding) {

        outstanding.textContent =
            formatRupiah(
                summary.outstanding
            );

    }

    const unpaidCount =
        getElement("iuranUnpaidCount");

    if (unpaidCount) {

        unpaidCount.textContent =
            summary.unpaidCount;

    }

    const filtered =
        active.filter(member => {

            const record =
                getIuranRecord(
                    member.id,
                    month,
                    year
                );

            const paid =
                Boolean(
                    record &&
                    getIuranStatus(record) ===
                    "LUNAS"
                );

            const text =
                [
                    member.number,
                    member.name,
                    member.position
                ]
                    .join(" ")
                    .toLowerCase();

            const matchSearch =
                !search ||
                text.includes(search);

            const matchStatus =
                !statusFilter ||
                (
                    statusFilter ===
                    "LUNAS" &&
                    paid
                ) ||
                (
                    statusFilter ===
                    "BELUM" &&
                    !paid
                );

            return (
                matchSearch &&
                matchStatus
            );
        });

    if (!filtered.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="empty-state">
                        <div>🪙</div>
                        Tidak ada data.
                    </div>
                </td>
            </tr>
        `;

    } else {

        tbody.innerHTML =
            filtered.map(
                (member, index) => {

                    const record =
                        getIuranRecord(
                            member.id,
                            month,
                            year
                        );

                    const paid =
                        Boolean(
                            record &&
                            getIuranStatus(record) ===
                            "LUNAS"
                        );

                    const amount =
                        record &&
                        Number.isFinite(
                            Number(
                                record.amount
                            )
                        )
                            ? Number(
                                record.amount
                            )
                            : Number(
                                iuranAmount
                            );

                    return `
                        <tr>

                            <td>${index + 1}</td>

                            <td>
                                ${escapeHTML(
                                    member.number
                                )}
                            </td>

                            <td>
                                <strong>
                                    ${escapeHTML(
                                        member.name
                                    )}
                                </strong>
                            </td>

                            <td>
                                <span class="
                                    badge
                                    ${paid
                                        ? "badge-success"
                                        : "badge-danger"}
                                ">
                                    ${paid
                                        ? "LUNAS"
                                        : "BELUM"}
                                </span>
                            </td>

                            <td>
                                ${formatRupiah(
                                    amount
                                )}
                            </td>

                            <td>
                                ${
                                    record?.paidDate
                                        ? formatDate(
                                            record.paidDate
                                        )
                                        : "-"
                                }
                            </td>

                            <td>

                                ${
                                    paid
                                        ? `
                                            <button
                                                class="table-action delete"
                                                onclick="cancelIuran(
                                                    '${record.id}'
                                                )">
                                                Batalkan
                                            </button>
                                          `
                                        : `
                                            ${record
                                                ? `<button
                                                    class="btn primary"
                                                    onclick="payIuran('${member.id}', ${month}, ${year})">
                                                    Bayar
                                                   </button>`
                                                : `<button
                                                    class="table-action"
                                                    onclick="recordIuranArrears('${member.id}', ${month}, ${year})">
                                                    Catat Tunggakan
                                                   </button>
                                                   <button
                                                    class="btn primary"
                                                    onclick="payIuran('${member.id}', ${month}, ${year})">
                                                    Bayar
                                                   </button>`
                                            }
                                          `
                                }

                            </td>

                        </tr>
                    `;
                }
            ).join("");
    }

    renderIuranArrearsList();
    renderIuranHistory();
}



function renderIuranArrearsList() {
    const tbody = getElement("iuranArrearsTable")?.querySelector("tbody");
    if (!tbody) return;

    const activeMembers = new Map(
        getActiveMembers().map(member => [String(member.id), member])
    );

    const unpaid = iuranData
        .filter(record => getIuranStatus(record) !== "LUNAS")
        .map(record => {
            const memberId = getIuranMemberId(record);
            const member = activeMembers.get(memberId) ||
                members.find(item => String(item.id) === memberId);
            const period = getIuranPeriod(record);
            const rawAmount = Number(record.amount);
            return {
                record,
                member,
                memberId,
                month: period.month,
                year: period.year,
                amount: Number.isFinite(rawAmount) && rawAmount > 0
                    ? rawAmount
                    : Number(iuranAmount)
            };
        })
        .filter(item => item.member && item.month >= 1 && item.month <= 12 && item.year > 0)
        .sort((a, b) => b.year - a.year || b.month - a.month ||
            String(a.member.name).localeCompare(String(b.member.name), "id"));

    const total = unpaid.reduce((sum, item) =>
        sum + (Number.isFinite(item.amount) && item.amount > 0 ? item.amount : 0), 0);
    const totalEl = getElement("iuranAllArrearsTotal");
    if (totalEl) totalEl.textContent = formatRupiah(total);

    // Rekap total tunggakan per anggota, dihitung hanya dari catatan belum lunas.
    const summaryBody = getElement("iuranArrearsSummaryTable")?.querySelector("tbody");
    if (summaryBody) {
        const grouped = new Map();
        unpaid.forEach(item => {
            const key = String(item.memberId);
            if (!grouped.has(key)) {
                grouped.set(key, { member: item.member, months: 0, total: 0 });
            }
            const summary = grouped.get(key);
            summary.months += 1;
            summary.total += item.amount;
        });
        const summaries = [...grouped.values()].sort((a, b) =>
            b.total - a.total || String(a.member.name).localeCompare(String(b.member.name), "id")
        );
        summaryBody.innerHTML = summaries.length
            ? summaries.map((item, index) => `
                <tr>
                    <td>${index + 1}</td>
                    <td>${escapeHTML(item.member.number ?? "-")}</td>
                    <td><strong>${escapeHTML(item.member.name ?? "-")}</strong></td>
                    <td>${item.months} bulan</td>
                    <td><strong>${formatRupiah(item.total)}</strong></td>
                    <td><button class="btn primary" onclick="openWhatsAppArrearsReminder('${String(item.member.id).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')">Buat Pengingat</button></td>
                </tr>
            `).join("")
            : `<tr><td colspan="6"><div class="empty-state">Belum ada tunggakan yang tercatat.</div></td></tr>`;
    }

    if (!unpaid.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7">
                    <div class="empty-state">
                        <div>✅</div>
                        Tidak ada tunggakan tercatat.
                    </div>
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = unpaid.map((item, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${escapeHTML(item.member.number ?? "-")}</td>
            <td><strong>${escapeHTML(item.member.name ?? "-")}</strong></td>
            <td>${escapeHTML(monthNames[item.month - 1])} ${item.year}</td>
            <td>${formatRupiah(item.amount)}</td>
            <td><span class="badge badge-danger">BELUM LUNAS</span></td>
            <td>
                <button class="btn primary"
                    onclick="payIuran('${String(item.memberId).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', ${item.month}, ${item.year})">
                    Bayar
                </button>
            </td>
        </tr>
    `).join("");
}

function openWhatsAppArrearsReminder(memberId) {
    const member = members.find(item => String(item.id) === String(memberId));
    if (!member) {
        showToast("Data anggota tidak ditemukan.");
        return;
    }

    const unpaid = iuranData
        .filter(record => getIuranMemberId(record) === String(memberId) && getIuranStatus(record) !== "LUNAS")
        .map(record => {
            const period = getIuranPeriod(record);
            const amountValue = Number(record.amount);
            return {
                month: period.month,
                year: period.year,
                amount: Number.isFinite(amountValue) && amountValue > 0 ? amountValue : Number(iuranAmount)
            };
        })
        .filter(item => item.month >= 1 && item.month <= 12 && item.year > 0)
        .sort((a, b) => a.year - b.year || a.month - b.month);

    if (!unpaid.length) {
        showToast("Anggota ini tidak memiliki tunggakan tercatat.");
        return;
    }

    const total = unpaid.reduce((sum, item) => sum + item.amount, 0);
    const periodLines = unpaid.map(item => `- ${monthNames[item.month - 1]} ${item.year}: ${formatRupiah(item.amount)}`).join("\n");
    const message = `Halo ${member.name || "Bapak/Ibu"},\n\nKami ingin mengingatkan bahwa berdasarkan catatan MedKas, masih terdapat iuran yang belum lunas:\n${periodLines}\n\nTotal tunggakan: ${formatRupiah(total)}.\n\nJika sudah membayar, mohon abaikan pesan ini atau konfirmasi kepada bendahara agar data dapat diperiksa. Terima kasih.`;
    const url = "https://wa.me/?text=" + encodeURIComponent(message);
    window.open(url, "_blank", "noopener,noreferrer");
}


function recordIuranArrears(memberId, month, year) {
    const member = members.find(m => String(m.id) === String(memberId));
    if (!member) return;

    if (getIuranRecord(memberId, month, year)) {
        alert("Catatan iuran untuk periode ini sudah ada.");
        return;
    }

    const amount = Number(iuranAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        alert("Nominal iuran harus lebih dari 0.");
        return;
    }

    if (!confirm(`Catat tunggakan ${member.name} untuk ${monthNames[month - 1]} ${year} sebesar ${formatRupiah(amount)}?\n\nIni hanya mencatat kewajiban, tidak menambah pemasukan kas.`)) {
        return;
    }

    iuranData.push({
        id: uid("iuran"),
        memberId,
        month,
        year,
        amount,
        // Harus sama dengan constraint Supabase: LUNAS / BELUM LUNAS
        status: "BELUM LUNAS",
        paidDate: "",
        transactionId: ""
    });

    saveJSON(IURAN_KEY, iuranData);
    renderAll();
    showToast("Tunggakan berhasil dicatat tanpa menambah pemasukan kas.");
}


function payIuran(memberId, month, year) {
    const member = members.find(m => String(m.id) === String(memberId));
    if (!member) return;

    const existingRecord = getIuranRecord(memberId, month, year);
    if (existingRecord && getIuranStatus(existingRecord) === "LUNAS") {
        alert("Iuran periode ini sudah dibayar.");
        return;
    }

    const amount = Number(existingRecord?.amount ?? iuranAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        alert("Nominal iuran harus lebih dari 0.");
        return;
    }

    if (!confirm(`Catat pembayaran iuran ${member.name} untuk ${monthNames[month - 1]} ${year} sebesar ${formatRupiah(amount)}?\n\nPemasukan kas akan dicatat karena pembayaran diterima sekarang.`)) {
        return;
    }

    const iuranId = existingRecord?.id || uid("iuran");
    const transactionId = uid("trx");
    const paidDate = today();

    const record = existingRecord || {
        id: iuranId,
        memberId,
        month,
        year,
        amount,
        status: "LUNAS",
        paidDate,
        transactionId
    };

    record.status = "LUNAS";
    record.paidDate = paidDate;
    record.transactionId = transactionId;

    if (!existingRecord) iuranData.push(record);

    const transaction = {
        id: transactionId,
        type: "Pemasukan",
        date: paidDate,
        description: `Iuran ${member.name} - ${monthNames[month - 1]} ${year}`,
        category: "Iuran",
        amount,
        source: "Iuran",
        isIuran: true,
        iuranId,
        memberId
    };

    transactions.push(transaction);
    saveJSON(IURAN_KEY, iuranData);
    saveJSON(TRANSACTION_KEY, transactions);
    renderAll();
    showToast("Pembayaran iuran berhasil dicatat.");
}

function cancelIuran(id) {

    const record =
        iuranData.find(
            r =>
                String(r.id) ===
                String(id)
        );

    if (!record) return;

    if (
        !confirm(
            "Batalkan pembayaran iuran ini?"
        )
    ) {
        return;
    }

    const transactionId =
        record.transactionId ||
        record.transaksiId ||
        record.transactionID ||
        record.transaksiID ||
        "";

    iuranData =
        iuranData.filter(
            r =>
                String(r.id) !==
                String(id)
        );

    if (transactionId) {

        transactions =
            transactions.filter(
                t =>
                    String(t.id) !==
                    String(transactionId)
            );

    } else {

        /* -------------------------------------------------
           V8:
           Jika data iuran lama tidak mempunyai transactionId,
           hapus hanya transaksi yang benar-benar teridentifikasi
           sebagai transaksi iuran terkait.
           ------------------------------------------------- */

        const memberId =
            getIuranMemberId(record);

        const period =
            getIuranPeriod(record);

        transactions =
            transactions.filter(t => {

                if (!isIuranTransaction(t)) {
                    return true;
                }

                const sameMember =
                    String(
                        t.memberId ??
                        ""
                    ) ===
                    memberId;

                const transactionDate =
                    String(
                        t.date ||
                        ""
                    );

                const periodPrefix =
                    `${period.year}-${String(
                        period.month
                    ).padStart(2, "0")}`;

                const samePeriod =
                    transactionDate.startsWith(
                        periodPrefix
                    );

                return !(
                    sameMember &&
                    samePeriod
                );

            });

    }

    saveJSON(
        IURAN_KEY,
        iuranData
    );

    saveJSON(
        TRANSACTION_KEY,
        transactions
    );

    renderAll();

    showToast(
        "Pembayaran iuran dibatalkan."
    );
}


function renderIuranHistory() {
    const tbody = getElement("iuranHistoryTable")?.querySelector("tbody");
    if (!tbody) return;

    const memberSelect = getElement("iuranHistoryMember");
    const yearSelect = getElement("iuranHistoryYear");
    const statusSelect = getElement("iuranHistoryStatus");
    const selectedMember = memberSelect?.value || "";
    const selectedYear = yearSelect?.value || "";
    const selectedStatus = statusSelect?.value || "";

    if (memberSelect && memberSelect.options.length <= 1) {
        const current = memberSelect.value;
        memberSelect.innerHTML = '<option value="">Semua anggota</option>' +
            [...members].sort((a,b) => String(a.name||"").localeCompare(String(b.name||""), "id"))
                .map(m => `<option value="${escapeHTML(String(m.id))}">${escapeHTML(m.name || "Tanpa nama")}</option>`).join("");
        memberSelect.value = current;
    }
    if (yearSelect && yearSelect.options.length <= 1) {
        const years = [...new Set(iuranData.map(r => getIuranPeriod(r).year).filter(Boolean))].sort((a,b)=>b-a);
        yearSelect.innerHTML = '<option value="">Semua tahun</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join("");
        yearSelect.value = selectedYear;
    }

    const list = [...iuranData].filter(r => {
        const period = getIuranPeriod(r);
        const status = getIuranStatus(r);
        return (!selectedMember || getIuranMemberId(r) === String(selectedMember)) &&
            (!selectedYear || period.year === Number(selectedYear)) &&
            (!selectedStatus || status === selectedStatus);
    }).sort((a,b) => {
        const pa=getIuranPeriod(a), pb=getIuranPeriod(b);
        return pb.year-pa.year || pb.month-pa.month || String(b.paidDate||"").localeCompare(String(a.paidDate||""));
    });

    const paidTotal = list.filter(r=>getIuranStatus(r)==="LUNAS").reduce((sum,r)=>sum+(Number(r.amount)||0),0);
    const unpaidTotal = list.filter(r=>getIuranStatus(r)!=="LUNAS").reduce((sum,r)=>sum+(Number(r.amount)||0),0);
    if (getElement("iuranHistoryPaidTotal")) getElement("iuranHistoryPaidTotal").textContent = formatRupiah(paidTotal);
    if (getElement("iuranHistoryUnpaidTotal")) getElement("iuranHistoryUnpaidTotal").textContent = formatRupiah(unpaidTotal);
    if (getElement("iuranHistoryCount")) getElement("iuranHistoryCount").textContent = String(list.length);

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div>📜</div>Tidak ada riwayat untuk filter yang dipilih.</div></td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(record => {
        const member = members.find(m => String(m.id) === getIuranMemberId(record));
        const period = getIuranPeriod(record);
        const status = getIuranStatus(record);
        const isPaid = status === "LUNAS";
        return `<tr>
            <td>${isPaid ? formatDate(record.paidDate) : "-"}</td>
            <td>${escapeHTML(monthNames[period.month - 1] || "-")} ${period.year || ""}</td>
            <td>${escapeHTML(member?.name || "-")}</td>
            <td>${formatRupiah(record.amount)}</td>
            <td><span class="badge ${isPaid ? "badge-success" : "badge-danger"}">${escapeHTML(status || "-")}</span></td>
            <td>${isPaid ? `<button class="table-action delete" title="Batalkan pembayaran" onclick="deleteIuranHistory('${String(record.id).replace(/'/g,"\\'")}')">🗑️</button>` : "-"}</td>
        </tr>`;
    }).join("");
}

function deleteIuranHistory(id) {

    cancelIuran(id);
}


/* =========================================================
   REPORT
   ========================================================= */

function renderReport() {

    const tbody =
        getElement("reportTable")
            ?.querySelector("tbody");

    if (!tbody) return;

    const start =
        getElement("reportStart")
            ?.value || "";

    const end =
        getElement("reportEnd")
            ?.value || "";

    const list =
        transactions
            .filter(
                t =>
                    inDateRange(
                        t.date,
                        start,
                        end
                    )
            )
            .sort(
                (a, b) =>
                    String(a.date)
                        .localeCompare(
                            String(b.date)
                        )
            );

    const income =
        list
            .filter(
                t =>
                    t.type ===
                    "Pemasukan"
            )
            .reduce(
                (s, t) =>
                    s + Number(t.amount || 0),
                0
            );

    const expense =
        list
            .filter(
                t =>
                    t.type ===
                    "Pengeluaran"
            )
            .reduce(
                (s, t) =>
                    s + Number(t.amount || 0),
                0
            );

    const reportIncome =
        getElement("reportIncome");

    if (reportIncome) {

        reportIncome.textContent =
            formatRupiah(income);

    }

    const reportExpense =
        getElement("reportExpense");

    if (reportExpense) {

        reportExpense.textContent =
            formatRupiah(expense);

    }

    const reportBalance =
        getElement("reportBalance");

    if (reportBalance) {

        reportBalance.textContent =
            formatRupiah(
                income - expense
            );

    }

    if (!list.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="5">
                    <div class="empty-state">
                        <div>📄</div>
                        Tidak ada data pada periode tersebut.
                    </div>
                </td>
            </tr>
        `;

        return;
    }

    tbody.innerHTML =
        list.map(t => {

            return `
                <tr>

                    <td>${formatDate(t.date)}</td>

                    <td>
                        <span class="
                            badge
                            ${
                                t.type ===
                                "Pemasukan"
                                    ? "badge-success"
                                    : "badge-danger"
                            }
                        ">
                            ${escapeHTML(
                                t.type
                            )}
                        </span>
                    </td>

                    <td>
                        ${escapeHTML(
                            t.description
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            t.category || "-"
                        )}
                    </td>

                    <td>
                        ${formatRupiah(
                            t.amount
                        )}
                    </td>

                </tr>
            `;

        }).join("");
}


function printReport() {

    showPage("laporan");

    renderReport();

    setTimeout(
        () => window.print(),
        100
    );
}


function csvEscape(value) {

    const text =
        String(value ?? "");

    return `"${text.replaceAll(
        '"',
        '""'
    )}"`;
}


function downloadTextFile(
    content,
    filename,
    mime = "text/plain"
) {

    const blob =
        new Blob(
            [content],
            {
                type:
                    `${mime};charset=utf-8`
            }
        );

    const url =
        URL.createObjectURL(blob);

    const a =
        document.createElement("a");

    a.href = url;
    a.download = filename;

    document.body.appendChild(a);

    a.click();

    a.remove();

    setTimeout(
        () =>
            URL.revokeObjectURL(url),
        1000
    );
}


function exportReportCSV() {

    const start =
        getElement("reportStart")
            ?.value || "";

    const end =
        getElement("reportEnd")
            ?.value || "";

    const list =
        transactions
            .filter(
                t =>
                    inDateRange(
                        t.date,
                        start,
                        end
                    )
            )
            .sort(
                (a, b) =>
                    String(a.date)
                        .localeCompare(
                            String(b.date)
                        )
            );

    const rows = [

        [
            "Tanggal",
            "Jenis",
            "Keterangan",
            "Kategori",
            "Jumlah"
        ],

        ...list.map(
            t => [
                t.date,
                t.type,
                t.description,
                t.category,
                t.amount
            ]
        )

    ];

    const csv =
        rows
            .map(
                row =>
                    row.map(
                        csvEscape
                    ).join(",")
            )
            .join("\n");

    downloadTextFile(
        "\ufeff" + csv,
        `laporan-kas-${today()}.csv`,
        "text/csv"
    );

    showToast(
        "Laporan CSV berhasil dibuat."
    );
}


/* =========================================================
   REKAP
   ========================================================= */

function initializeRecapYears() {

    const select =
        getElement("recapYear");

    if (!select) return;

    const current =
        new Date().getFullYear();

    const old =
        select.value;

    const years = new Set();

    years.add(current);

    if (getCurrentUserRole() === USER_ROLES.USER && onlineSummary) {
        (onlineSummary.years || []).forEach(y => years.add(Number(y)));
    }

    transactions.forEach(t => {

        const y =
            getYearFromDate(t.date);

        if (y) years.add(y);

    });

    iuranData.forEach(r => {

        const y =
            Number(
                r.year ??
                r.tahun
            );

        if (y) years.add(y);

    });

    select.innerHTML =
        [...years]
            .sort(
                (a, b) => a - b
            )
            .map(
                y =>
                    `<option value="${y}">
                        ${y}
                    </option>`
            )
            .join("");

    /*
       V8:
       Jangan selalu kembali ke tahun sekarang.
       Pertahankan tahun yang dipilih user jika masih tersedia.
    */

    select.value =
        [...years]
            .map(String)
            .includes(old)
                ? old
                : String(current);
}


function getMonthlyData(year) {

    if (getCurrentUserRole() === USER_ROLES.USER && onlineSummary && Number(onlineSummary.year) === Number(year)) {
        return (onlineSummary.monthly || []).map(row => ({
            month: Number(row.month) || 0,
            manual: Number(row.manual) || 0,
            iuran: Number(row.iuran) || 0,
            income: Number(row.income) || 0,
            expense: Number(row.expense) || 0,
            balance: Number(row.balance) || 0,
            transactions: Number(row.transactions) || 0
        }));
    }

    const data = [];

    for (
        let month = 1;
        month <= 12;
        month++
    ) {

        const prefix =
            `${year}-${String(month).padStart(2, "0")}`;

        const list =
            transactions.filter(
                t =>
                    String(t.date || "")
                        .startsWith(prefix)
            );

        const manual =
            list
                .filter(
                    t =>
                        t.type === "Pemasukan" &&
                        !isIuranTransaction(t)
                )
                .reduce(
                    (s, t) =>
                        s + Number(t.amount || 0),
                    0
                );

        const iuran =
            list
                .filter(
                    t =>
                        t.type === "Pemasukan" &&
                        isIuranTransaction(t)
                )
                .reduce(
                    (s, t) =>
                        s + Number(t.amount || 0),
                    0
                );

        const expense =
            list
                .filter(
                    t =>
                        t.type === "Pengeluaran"
                )
                .reduce(
                    (s, t) =>
                        s + Number(t.amount || 0),
                    0
                );

        data.push({

            month,

            manual,

            iuran,

            income:
                manual + iuran,

            expense,

            balance:
                manual +
                iuran -
                expense,

            transactions:
                list.length

        });

    }

    return data;
}


function renderRecap() {

    initializeRecapYears();

    const year =
        Number(
            getElement("recapYear")
                ?.value
        ) ||
        new Date().getFullYear();

    const tbody =
        getElement("recapTable")
            ?.querySelector("tbody");

    if (!tbody) return;

    const data =
        getMonthlyData(year);

    let manualTotal = 0;
    let iuranTotal = 0;
    let incomeTotal = 0;
    let expenseTotal = 0;
    let transactionTotal = 0;

    tbody.innerHTML =
        data.map(row => {

            manualTotal +=
                row.manual;

            iuranTotal +=
                row.iuran;

            incomeTotal +=
                row.income;

            expenseTotal +=
                row.expense;

            transactionTotal +=
                row.transactions;

            return `
                <tr>

                    <td>
                        <strong>
                            ${monthNames[
                                row.month - 1
                            ]}
                        </strong>
                    </td>

                    <td>
                        ${formatRupiah(
                            row.manual
                        )}
                    </td>

                    <td>
                        ${formatRupiah(
                            row.iuran
                        )}
                    </td>

                    <td>
                        ${formatRupiah(
                            row.income
                        )}
                    </td>

                    <td>
                        ${formatRupiah(
                            row.expense
                        )}
                    </td>

                    <td>
                        ${formatRupiah(
                            row.balance
                        )}
                    </td>

                    <td>
                        ${row.transactions}
                    </td>

                </tr>
            `;

        }).join("");

    const recapManualTotal =
        getElement("recapManualTotal");

    if (recapManualTotal) {

        recapManualTotal.textContent =
            formatRupiah(
                manualTotal
            );

    }

    const recapIuranTotal =
        getElement("recapIuranTotal");

    if (recapIuranTotal) {

        recapIuranTotal.textContent =
            formatRupiah(
                iuranTotal
            );

    }

    const recapIncomeTotal =
        getElement("recapIncomeTotal");

    if (recapIncomeTotal) {

        recapIncomeTotal.textContent =
            formatRupiah(
                incomeTotal
            );

    }

    const recapExpenseTotal =
        getElement("recapExpenseTotal");

    if (recapExpenseTotal) {

        recapExpenseTotal.textContent =
            formatRupiah(
                expenseTotal
            );

    }

    const recapBalanceTotal =
        getElement("recapBalanceTotal");

    if (recapBalanceTotal) {

        recapBalanceTotal.textContent =
            formatRupiah(
                incomeTotal -
                expenseTotal
            );

    }

    const recapTransactionTotal =
        getElement("recapTransactionTotal");

    if (recapTransactionTotal) {

        recapTransactionTotal.textContent =
            transactionTotal;

    }
}


function exportRecapCSV() {

    const year =
        Number(
            getElement("recapYear")
                ?.value
        ) ||
        new Date().getFullYear();

    const data =
        getMonthlyData(year);

    const rows = [

        [
            "Bulan",
            "Pemasukan Manual",
            "Iuran",
            "Total Pemasukan",
            "Pengeluaran",
            "Saldo",
            "Transaksi"
        ],

        ...data.map(
            row => [
                monthNames[
                    row.month - 1
                ],
                row.manual,
                row.iuran,
                row.income,
                row.expense,
                row.balance,
                row.transactions
            ]
        )

    ];

    const csv =
        rows
            .map(
                row =>
                    row.map(
                        csvEscape
                    ).join(",")
            )
            .join("\n");

    downloadTextFile(
        "\ufeff" + csv,
        `rekap-kas-${year}.csv`,
        "text/csv"
    );

    showToast(
        "Rekap CSV berhasil dibuat."
    );
}


/* =========================================================
   SIMPLE CANVAS CHARTS
   ========================================================= */

function setupCanvas(canvas) {

    if (!canvas) return null;

    const ratio =
        window.devicePixelRatio || 1;

    const rect =
        canvas.getBoundingClientRect();

    const width =
        Math.max(
            rect.width,
            300
        );

    const height =
        Math.max(
            rect.height,
            240
        );

    canvas.width =
        width * ratio;

    canvas.height =
        height * ratio;

    const ctx =
        canvas.getContext("2d");

    if (!ctx) return null;

    ctx.setTransform(
        ratio,
        0,
        0,
        ratio,
        0,
        0
    );

    return {
        ctx,
        width,
        height
    };
}


function drawBarChart(
    canvas,
    labels,
    series
) {

    const setup =
        setupCanvas(canvas);

    if (!setup) return;

    const {
        ctx,
        width,
        height
    } = setup;

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    const left = 55;
    const right = 15;
    const top = 25;
    const bottom = 45;

    const chartWidth =
        width -
        left -
        right;

    const chartHeight =
        height -
        top -
        bottom;

    const max =
        Math.max(
            1,
            ...series.flatMap(
                s =>
                    s.values.map(
                        value =>
                            Number(value) || 0
                    )
            )
        );

    ctx.strokeStyle =
        "#e3efeb";

    ctx.fillStyle =
        "#849398";

    ctx.font =
        "11px Segoe UI";

    for (
        let i = 0;
        i <= 4;
        i++
    ) {

        const y =
            top +
            chartHeight -
            (
                chartHeight *
                i /
                4
            );

        ctx.beginPath();

        ctx.moveTo(
            left,
            y
        );

        ctx.lineTo(
            width - right,
            y
        );

        ctx.stroke();

        const value =
            max *
            i /
            4;

        ctx.fillText(
            formatCompact(value),
            5,
            y + 4
        );
    }

    const groupWidth =
        labels.length
            ? chartWidth /
                labels.length
            : chartWidth;

    const barWidth =
        Math.min(
            20,
            groupWidth /
                (
                    series.length + 1
                )
        );

    series.forEach(
        (serie, seriesIndex) => {

            ctx.fillStyle =
                serie.color;

            serie.values.forEach(
                (value, index) => {

                    const safeValue =
                        Math.max(
                            0,
                            Number(value) || 0
                        );

                    const barHeight =
                        (
                            safeValue /
                            max
                        ) *
                        chartHeight;

                    const x =
                        left +
                        index *
                        groupWidth +
                        (
                            groupWidth -
                            (
                                barWidth *
                                series.length
                            )
                        ) /
                        2 +
                        seriesIndex *
                        barWidth;

                    const y =
                        top +
                        chartHeight -
                        barHeight;

                    ctx.fillRect(
                        x,
                        y,
                        Math.max(
                            3,
                            barWidth - 3
                        ),
                        barHeight
                    );

                }
            );

        }
    );

    ctx.fillStyle =
        "#849398";

    labels.forEach(
        (label, index) => {

            const x =
                left +
                index *
                groupWidth +
                groupWidth /
                2 -
                10;

            ctx.fillText(
                label,
                x,
                height - 17
            );

        }
    );
}


function formatCompact(value) {

    const n =
        Number(value) || 0;

    if (n >= 1000000000) {

        return (
            (n / 1000000000)
                .toFixed(1) +
            "M"
        );

    }

    if (n >= 1000000) {

        return (
            (n / 1000000)
                .toFixed(1) +
            "jt"
        );

    }

    if (n >= 1000) {

        return (
            (n / 1000)
                .toFixed(0) +
            "rb"
        );

    }

    return String(
        Math.round(n)
    );
}


function drawLineChart(
    canvas,
    labels,
    values
) {

    const setup =
        setupCanvas(canvas);

    if (!setup) return;

    const {
        ctx,
        width,
        height
    } = setup;

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    const left = 50;
    const right = 20;
    const top = 20;
    const bottom = 40;

    const chartWidth =
        width -
        left -
        right;

    const chartHeight =
        height -
        top -
        bottom;

    const safeValues =
        values.map(
            value =>
                Number(value) || 0
        );

    const max =
        Math.max(
            1,
            ...safeValues.map(
                Math.abs
            )
        );

    const min =
        Math.min(
            0,
            ...safeValues
        );

    const range =
        Math.max(
            1,
            max - min
        );

    ctx.strokeStyle =
        "#e3efeb";

    ctx.fillStyle =
        "#849398";

    ctx.font =
        "11px Segoe UI";

    for (
        let i = 0;
        i <= 4;
        i++
    ) {

        const value =
            min +
            range *
            (
                1 -
                i / 4
            );

        const y =
            top +
            chartHeight *
            i /
            4;

        ctx.beginPath();

        ctx.moveTo(
            left,
            y
        );

        ctx.lineTo(
            width - right,
            y
        );

        ctx.stroke();

        ctx.fillText(
            formatCompact(value),
            4,
            y + 4
        );
    }

    const points =
        safeValues.map(
            (value, index) => {

                const x =
                    left +
                    (
                        index /
                        Math.max(
                            1,
                            safeValues.length - 1
                        )
                    ) *
                    chartWidth;

                const y =
                    top +
                    (
                        1 -
                        (
                            value -
                            min
                        ) /
                        range
                    ) *
                    chartHeight;

                return {
                    x,
                    y
                };
            }
        );

    if (points.length) {

        ctx.beginPath();

        points.forEach(
            (point, index) => {

                if (index === 0) {

                    ctx.moveTo(
                        point.x,
                        point.y
                    );

                } else {

                    ctx.lineTo(
                        point.x,
                        point.y
                    );

                }

            }
        );

        ctx.strokeStyle =
            "#67bfa9";

        ctx.lineWidth = 3;

        ctx.stroke();

        ctx.lineWidth = 1;

        points.forEach(
            point => {

                ctx.beginPath();

                ctx.arc(
                    point.x,
                    point.y,
                    4,
                    0,
                    Math.PI * 2
                );

                ctx.fillStyle =
                    "#67bfa9";

                ctx.fill();

            }
        );
    }

    ctx.fillStyle =
        "#849398";

    labels.forEach(
        (label, index) => {

            const point =
                points[index];

            if (!point) return;

            ctx.fillText(
                label,
                point.x - 9,
                height - 15
            );

        }
    );
}


function renderCharts() {

    initializeChartYears();

    const year =
        Number(
            getElement("chartYear")
                ?.value
        ) ||
        new Date().getFullYear();

    if (getCurrentUserRole() === USER_ROLES.USER && (!onlineSummary || Number(onlineSummary.year) !== year)) {
        void loadOnlineSummary(year).then(ok => {
            if (ok) {
                initializeChartYears();
                renderCharts();
                renderDashboard();
            }
        });
        return;
    }

    const data =
        getMonthlyData(year);

    const labels =
        monthNames.map(
            m => m.slice(0, 3)
        );

    drawBarChart(
        getElement(
            "incomeExpenseChart"
        ),
        labels,
        [
            {
                values:
                    data.map(
                        d => d.income
                    ),
                color:
                    "#67bfa9"
            },
            {
                values:
                    data.map(
                        d => d.expense
                    ),
                color:
                    "#e47c7c"
            }
        ]
    );

    drawBarChart(
        getElement(
            "iuranChart"
        ),
        labels,
        [
            {
                values:
                    data.map(
                        d => d.iuran
                    ),
                color:
                    "#8c79d8"
            }
        ]
    );

    let running = 0;

    const balances =
        data.map(
            d => {

                running +=
                    d.balance;

                return running;
            }
        );

    drawLineChart(
        getElement(
            "balanceChart"
        ),
        labels,
        balances
    );
}


function initializeChartYears() {

    const select =
        getElement("chartYear");

    if (!select) return;

    const current =
        new Date().getFullYear();

    const years = new Set();

    years.add(current);

    if (getCurrentUserRole() === USER_ROLES.USER && onlineSummary) {
        (onlineSummary.years || []).forEach(y => years.add(Number(y)));
    }

    transactions.forEach(t => {

        const y =
            getYearFromDate(
                t.date
            );

        if (y) years.add(y);

    });

    iuranData.forEach(r => {

        const y =
            Number(
                r.year ??
                r.tahun
            );

        if (y) years.add(y);

    });

    const old =
        select.value;

    select.innerHTML =
        [...years]
            .sort(
                (a, b) =>
                    a - b
            )
            .map(
                y =>
                    `<option value="${y}">
                        ${y}
                    </option>`
            )
            .join("");

    select.value =
        [...years]
            .map(String)
            .includes(old)
            ? old
            : String(current);
}


/* =========================================================
   BACKUP
   ========================================================= */

function createBackupObject() {

    return {

        version: "V8",

        createdAt:
            new Date().toISOString(),

        transactions:
            transactions,

        members:
            members,

        iuranData:
            iuranData,

        iuranAmount:
            iuranAmount

    };
}


function backupData(
    silent = false
) {

    const data =
        createBackupObject();

    const json =
        JSON.stringify(
            data,
            null,
            2
        );

    const date =
        today();

    downloadTextFile(
        json,
        `backup-kas-ruangan-${date}.json`,
        "application/json"
    );

    const info = {

        date:
            new Date().toISOString(),

        filename:
            `backup-kas-ruangan-${date}.json`

    };

    localStorage.setItem(
        LAST_BACKUP_KEY,
        JSON.stringify(info)
    );

    updateSafetyInfo();

    if (!silent) {

        showToast(
            "Backup data berhasil dibuat."
        );
    }

    return true;
}


/* =========================================================
   RESTORE
   ========================================================= */

function restoreData(event) {

    if (!isCurrentUserAdmin()) {
        if (event?.target) event.target.value = "";
        showToast("Hanya Admin yang dapat melakukan Restore data.");
        return;
    }

    const file =
        event.target.files?.[0];

    if (!file) return;

    const reader =
        new FileReader();

    reader.onload = function () {

        try {

            const data =
                JSON.parse(
                    reader.result
                );

            if (
                !data ||
                typeof data !== "object"
            ) {
                throw new Error(
                    "Format backup tidak valid."
                );
            }

            const hasTransactions =
                Array.isArray(
                    data.transactions
                );

            const hasMembers =
                Array.isArray(
                    data.members
                );

            const hasIuran =
                Array.isArray(
                    data.iuranData
                );

            if (
                !hasTransactions &&
                !hasMembers &&
                !hasIuran
            ) {

                throw new Error(
                    "File tidak berisi data MedKas."
                );
            }

            if (
                !confirm(
                    "Restore akan mengganti data saat ini. Lanjutkan?"
                )
            ) {
                event.target.value = "";
                return;
            }

            /*
               V8:
               Simpan snapshot data saat ini sebelum restore.
               Jika restore gagal setelah konfirmasi,
               data lama masih dapat dipulihkan melalui
               snapshot reset.
            */

            createResetSnapshot();

            if (hasTransactions) {

                transactions =
                    data.transactions;

            }

            if (hasMembers) {

                members =
                    data.members;

            }

            if (hasIuran) {

                iuranData =
                    data.iuranData;

            }

            if (
                data.iuranAmount !==
                undefined
            ) {

                const restoredAmount =
                    Number(
                        data.iuranAmount
                    );

                if (
                    Number.isFinite(
                        restoredAmount
                    ) &&
                    restoredAmount >= 0
                ) {

                    iuranAmount =
                        restoredAmount;

                }

            }

            /*
               V8:
               Normalisasi dilakukan sebelum save.
            */

            normalizeMembers();
            normalizeTransactions();
            normalizeIuranData();

            saveJSON(
                TRANSACTION_KEY,
                transactions
            );

            saveJSON(
                MEMBER_KEY,
                members
            );

            saveJSON(
                IURAN_KEY,
                iuranData
            );

            localStorage.setItem(
                IURAN_AMOUNT_KEY,
                String(iuranAmount)
            );

            initializeIuranControls();

            renderAll();

            alert(
                `Restore berhasil.\nVersi backup: ${
                    data.version || "lama/V5"
                }`
            );

        } catch (error) {

            console.error(error);

            alert(
                "Restore gagal:\n" +
                error.message
            );

        } finally {

            event.target.value = "";
        }

    };

    reader.onerror = function () {

        alert(
            "File backup tidak dapat dibaca."
        );

        event.target.value = "";
    };

    reader.readAsText(file);
}


/* =========================================================
   RESET SYSTEM
   ========================================================= */

let pendingResetType = null;


function openResetModal(type) {

    if (!isCurrentUserAdmin()) {
        showToast("Hanya Admin yang dapat melakukan Reset data.");
        return;
    }

    pendingResetType = type;

    const modal =
        getElement("resetModal");

    const title =
        getElement("resetTitle");

    const description =
        getElement(
            "resetDescription"
        );

    const descriptions = {

        transactions:
            [
                "Reset Transaksi",
                "Semua transaksi pemasukan dan pengeluaran akan dihapus. Data anggota dan nominal iuran tetap dipertahankan."
            ],

        iuran:
            [
                "Reset Iuran",
                "Semua data pembayaran iuran akan dihapus beserta transaksi pemasukan iuran yang terkait. Data anggota tetap dipertahankan."
            ],

        allExceptMembers:
            [
                "Reset Semua kecuali Anggota",
                "Transaksi dan seluruh data iuran akan dihapus. Data anggota tetap dipertahankan."
            ],

        all:
            [
                "Reset Semua Data",
                "Semua transaksi, iuran, nominal iuran, dan anggota akan dihapus."
            ]

    };

    const selected =
        descriptions[type];

    if (title) {

        title.textContent =
            selected
                ? selected[0]
                : "Reset Data";

    }

    if (description) {

        description.textContent =
            selected
                ? selected[1]
                : "Data akan dihapus.";

    }

    const backupCheckbox =
        getElement(
            "backupBeforeReset"
        );

    if (backupCheckbox) {

        backupCheckbox.checked = true;

    }

    if (modal) {

        modal.classList.add("show");

    }
}


function closeResetModal() {

    pendingResetType = null;

    const modal =
        getElement("resetModal");

    if (modal) {

        modal.classList.remove("show");

    }
}


function createResetSnapshot() {

    const snapshot = {

        version: "V8-RESET",

        createdAt:
            new Date().toISOString(),

        transactions:
            JSON.parse(
                JSON.stringify(
                    transactions
                )
            ),

        members:
            JSON.parse(
                JSON.stringify(
                    members
                )
            ),

        iuranData:
            JSON.parse(
                JSON.stringify(
                    iuranData
                )
            ),

        iuranAmount:
            iuranAmount

    };

    saveJSON(
        RESET_BACKUP_KEY,
        snapshot
    );

    updateSafetyInfo();
}


function confirmReset() {

    if (!isCurrentUserAdmin()) {
        pendingResetType = null;
        closeResetModal();
        showToast("Hanya Admin yang dapat melakukan Reset data.");
        return;
    }

    if (!pendingResetType) {
        return;
    }

    const type =
        pendingResetType;

    const backupCheckbox =
        getElement(
            "backupBeforeReset"
        );

    const backup =
        backupCheckbox
            ? backupCheckbox.checked
            : true;

    const confirmation =
        confirm(
            "PERINGATAN!\n\n" +
            "Data yang dipilih akan direset.\n" +
            (
                backup
                    ? "Backup otomatis akan dibuat terlebih dahulu."
                    : "Backup otomatis TIDAK dibuat."
            ) +
            "\n\nLanjutkan?"
        );

    if (!confirmation) {
        return;
    }

    if (backup) {

        createResetSnapshot();

        backupData(true);

    } else {

        createResetSnapshot();

    }

    if (
        type ===
        "transactions"
    ) {

        transactions = [];

    } else if (
        type ===
        "iuran"
    ) {

        const iuranTransactionIds =
            new Set(
                iuranData
                    .map(
                        r =>
                            r.transactionId
                    )
                    .filter(Boolean)
            );

        transactions =
            transactions.filter(
                t =>
                    !(
                        isIuranTransaction(t) ||
                        iuranTransactionIds.has(
                            t.id
                        )
                    )
            );

        iuranData = [];

    } else if (
        type ===
        "allExceptMembers"
    ) {

        transactions = [];
        iuranData = [];

    } else if (
        type ===
        "all"
    ) {

        transactions = [];
        iuranData = [];
        members = [];

        iuranAmount = 10000;

        localStorage.setItem(
            IURAN_AMOUNT_KEY,
            String(iuranAmount)
        );
    }

    saveJSON(
        TRANSACTION_KEY,
        transactions
    );

    saveJSON(
        IURAN_KEY,
        iuranData
    );

    saveJSON(
        MEMBER_KEY,
        members
    );

    closeResetModal();

    initializeIuranControls();

    renderAll();

    updateSafetyInfo();

    showToast(
        "Reset berhasil. Data sebelumnya dapat dikembalikan."
    );
}


function undoLastReset() {

    if (!isCurrentUserAdmin()) {
        showToast("Hanya Admin yang dapat membatalkan Reset.");
        return;
    }

    const snapshot =
        loadJSON(
            RESET_BACKUP_KEY,
            null
        );

    if (!snapshot) {

        alert(
            "Tidak ada snapshot reset yang tersedia."
        );

        return;
    }

    if (
        !confirm(
            "Kembalikan data sebelum reset terakhir?"
        )
    ) {
        return;
    }

    if (
        Array.isArray(
            snapshot.transactions
        )
    ) {

        transactions =
            snapshot.transactions;

    }

    if (
        Array.isArray(
            snapshot.members
        )
    ) {

        members =
            snapshot.members;

    }

    if (
        Array.isArray(
            snapshot.iuranData
        )
    ) {

        iuranData =
            snapshot.iuranData;

    }

    const restoredAmount =
        Number(
            snapshot.iuranAmount
        );

    iuranAmount =
        Number.isFinite(
            restoredAmount
        ) &&
        restoredAmount >= 0
            ? restoredAmount
            : 10000;

    /*
       V8 IMPORTANT:
       Normalisasi dilakukan SEBELUM data disimpan.
       Versi lama melakukan save dahulu lalu normalize,
       sehingga hasil normalisasi bisa hilang ketika reload.
    */

    normalizeMembers();
    normalizeTransactions();
    normalizeIuranData();

    saveJSON(
        TRANSACTION_KEY,
        transactions
    );

    saveJSON(
        MEMBER_KEY,
        members
    );

    saveJSON(
        IURAN_KEY,
        iuranData
    );

    localStorage.setItem(
        IURAN_AMOUNT_KEY,
        String(iuranAmount)
    );

    localStorage.removeItem(
        RESET_BACKUP_KEY
    );

    initializeIuranControls();

    renderAll();

    updateSafetyInfo();

    showToast(
        "Data sebelum reset berhasil dikembalikan."
    );
}


/* =========================================================
   SAFETY INFO
   ========================================================= */

function updateSafetyInfo() {

    const lastBackup =
        loadJSON(
            LAST_BACKUP_KEY,
            null
        );

    const backupInfo =
        getElement(
            "lastBackupInfo"
        );

    if (
        backupInfo &&
        lastBackup?.date
    ) {

        backupInfo.textContent =
            "Backup terakhir: " +
            new Date(
                lastBackup.date
            ).toLocaleString(
                "id-ID"
            );

    } else if (backupInfo) {

        backupInfo.textContent =
            "Belum ada backup.";

    }

    const resetSnapshot =
        loadJSON(
            RESET_BACKUP_KEY,
            null
        );

    const resetInfo =
        getElement(
            "resetBackupInfo"
        );

    const undoButton =
        getElement(
            "undoResetBtn"
        );

    if (
        resetSnapshot?.createdAt
    ) {

        if (resetInfo) {

            resetInfo.textContent =
                "Snapshot tersedia: " +
                new Date(
                    resetSnapshot.createdAt
                ).toLocaleString(
                    "id-ID"
                );
        }

        if (undoButton) {
            undoButton.disabled = false;
        }

    } else {

        if (resetInfo) {

            resetInfo.textContent =
                "Tidak ada snapshot reset.";
        }

        if (undoButton) {
            undoButton.disabled = true;
        }
    }
}


/* =========================================================
   RENDER ALL
   ========================================================= */

function renderAll() {

    /*
       Normalisasi tetap dilakukan seperti V7.
       Tidak mengubah tampilan atau alur render.
    */

    normalizeMembers();
    normalizeTransactions();
    normalizeIuranData();

    populateUserMemberOptions();

    renderDashboard();

    renderMembers();

    renderIncome();

    renderExpenses();

    renderIuran();

    renderReport();

    renderRecap();

    renderCharts();

    updateSafetyInfo();
}


/* =========================================================
   CURRENT DATE
   ========================================================= */

function updateCurrentDate() {

    const element =
        getElement("currentDate");

    if (!element) return;

    element.textContent =
        new Date().toLocaleDateString(
            "id-ID",
            {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
            }
        );
}


/* =========================================================
   EVENT LISTENERS
   ========================================================= */

getElement("addMemberBtn")
    ?.addEventListener(
        "click",
        () =>
            openMemberModal()
    );


getElement("memberForm")
    ?.addEventListener(
        "submit",
        saveMember
    );


getElement("transactionForm")
    ?.addEventListener(
        "submit",
        saveTransaction
    );


getElement("saveIuranAmount")
    ?.addEventListener(
        "click",
        saveIuranAmount
    );


getElement("generateReport")
    ?.addEventListener(
        "click",
        renderReport
    );

// Rekap cepat berdasarkan satu bulan tanpa mengubah data transaksi.
function applyReportMonth() {
    const monthValue = getElement("reportMonth")?.value;
    if (!monthValue) {
        alert("Pilih bulan terlebih dahulu.");
        return;
    }
    const [year, month] = monthValue.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    getElement("reportStart").value = start;
    getElement("reportEnd").value = end;
    renderReport();
}

getElement("applyReportMonth")
    ?.addEventListener("click", applyReportMonth);

// Default pilihan laporan ke bulan berjalan.
(function initReportMonth() {
    const input = getElement("reportMonth");
    if (input && !input.value) {
        const now = new Date();
        input.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
})();


getElement("refreshRecap")
    ?.addEventListener(
        "click",
        renderRecap
    );


getElement("backupBtn")
    ?.addEventListener(
        "click",
        backupData
    );


getElement("restoreFile")
    ?.addEventListener(
        "change",
        restoreData
    );


getElement("restoreFilePage")
    ?.addEventListener(
        "change",
        restoreData
    );


getElement("confirmResetBtn")
    ?.addEventListener(
        "click",
        confirmReset
    );


/* MEMBER FILTERS */

[
    "memberSearch",
    "memberStatusFilter"
].forEach(id => {

    getElement(id)
        ?.addEventListener(
            "input",
            renderMembers
        );

    getElement(id)
        ?.addEventListener(
            "change",
            renderMembers
        );

});


/* INCOME FILTERS */

[
    "incomeSearch",
    "incomeFilter",
    "incomeStartDate",
    "incomeEndDate",
    "incomeCategoryFilter"
].forEach(id => {

    getElement(id)
        ?.addEventListener(
            "input",
            renderIncome
        );

    getElement(id)
        ?.addEventListener(
            "change",
            renderIncome
        );

});


/* EXPENSE FILTERS */

[
    "expenseSearch",
    "expenseStartDate",
    "expenseEndDate",
    "expenseCategoryFilter"
].forEach(id => {

    getElement(id)
        ?.addEventListener(
            "input",
            renderExpenses
        );

    getElement(id)
        ?.addEventListener(
            "change",
            renderExpenses
        );

});


/* RIWAYAT PEMBAYARAN PER ANGGOTA */
["iuranHistoryMember", "iuranHistoryYear", "iuranHistoryStatus"].forEach(id => {
    getElement(id)?.addEventListener("change", renderIuranHistory);
});

/* IURAN FILTERS */

[
    "iuranMonth",
    "iuranYear",
    "iuranSearch",
    "iuranStatusFilter"
].forEach(id => {

    getElement(id)
        ?.addEventListener(
            "input",
            renderIuran
        );

    getElement(id)
        ?.addEventListener(
            "change",
            renderIuran
        );

});


getElement("recapYear")
    ?.addEventListener(
        "change",
        renderRecap
    );


getElement("chartYear")
    ?.addEventListener(
        "change",
        renderCharts
    );


/* =========================================================
   MODAL OUTSIDE CLICK
   ========================================================= */

[
    "memberModal",
    "transactionModal",
    "resetModal",
    "userManagementModal"
].forEach(id => {

    getElement(id)
        ?.addEventListener(
            "click",
            event => {

                if (
                    event.target.id === id
                ) {

                    if (
                        id ===
                        "memberModal"
                    ) {
                        closeMemberModal();
                    }

                    if (
                        id ===
                        "transactionModal"
                    ) {
                        closeTransactionModal();
                    }

                    if (
                        id ===
                        "resetModal"
                    ) {
                        closeResetModal();
                    }

                    if (
                        id ===
                        "userManagementModal"
                    ) {
                        closeUserManagementModal();
                    }

                }

            }
        );

});


/* =========================================================
   ESC CLOSE MODAL
   ========================================================= */

document.addEventListener(
    "keydown",
    event => {

        if (
            event.key !== "Escape"
        ) {
            return;
        }

        closeMemberModal();
        closeTransactionModal();
        closeResetModal();
        closeUserManagementModal();

    }
);


/* =========================================================
   RESIZE CHART
   ========================================================= */

let chartResizeTimer = null;

window.addEventListener(
    "resize",
    () => {

        clearTimeout(
            chartResizeTimer
        );

        chartResizeTimer =
            setTimeout(
                () => {

                    const page =
                        document
                            .querySelector(
                                ".page.active"
                            );

                    /*
                       V8:
                       Grafik hanya dirender ulang
                       jika halaman grafik sedang aktif.
                    */

                    if (
                        page?.id ===
                        "page-grafik"
                    ) {

                        renderCharts();

                    }

                },
                150
            );

    }
);


/* =========================================================
   INITIALIZATION
   ========================================================= */

normalizeMembers();
normalizeTransactions();
normalizeIuranData();

initializeIuranControls();

initializeRecapYears();

initializeChartYears();

updateCurrentDate();

renderAll();

setInterval(
    updateCurrentDate,
    60000
);

/* =========================================================
   LOGIN V8
   ========================================================= */

const LOGIN_SESSION_KEY = "kasRuanganLoginV8";
const LOGIN_USERNAME_KEY = "kasRuanganUsernameV8";
const LOGIN_PASSWORD_KEY = "kasRuanganPasswordV8";


/* =========================================================
   DATA LOGIN
   ========================================================= */

function getLoginUsername() {

    return localStorage.getItem(
        LOGIN_USERNAME_KEY
    ) || "admin";

}


function getLoginPassword() {

    return localStorage.getItem(
        LOGIN_PASSWORD_KEY
    ) || "admin123";

}


/* =========================================================
   CEK SESSION
   ========================================================= */

function isLoggedIn() {

    return localStorage.getItem(
        LOGIN_SESSION_KEY
    ) === "true";

}


/* =========================================================
   TAMPILKAN LOGIN
   ========================================================= */

function showLoginScreen() {

    const loginScreen =
        document.getElementById(
            "loginScreen"
        );

    if (!loginScreen) {
        return;
    }

    loginScreen.style.display = "flex";

}


/* =========================================================
   SEMBUNYIKAN LOGIN
   ========================================================= */

function hideLoginScreen() {

    const loginScreen =
        document.getElementById(
            "loginScreen"
        );

    if (!loginScreen) {
        return;
    }

    loginScreen.style.display = "none";

}


/* =========================================================
   LOGOUT
   ========================================================= */

function logoutKasRuangan() {

    if (!confirm("Apakah Anda yakin ingin keluar?")) {
        return;
    }

    const finish = () => {
        onlineReady = false;
        onlineCurrentAuthUser = null;
        onlineAdminCredentials = null;

        localStorage.removeItem(LOGIN_SESSION_KEY);
        localStorage.removeItem(CURRENT_USER_KEY);

        showLoginScreen();

        const username = document.getElementById("loginUsername");
        const password = document.getElementById("loginPassword");
        const error = document.getElementById("loginError");

        if (username) username.value = "";
        if (password) password.value = "";
        if (error) error.hidden = true;
    };

    if (supabaseClient) {
        void supabaseClient.auth.signOut().finally(finish);
    } else {
        finish();
    }
}


/* =========================================================
   LOGIN
   ========================================================= */

/* =========================================================
   LOGIN V9
   ========================================================= */

function initializeLogin() {

    const form = document.getElementById("loginForm");
    const toggle = document.getElementById("togglePassword");

    if (form) {
        form.addEventListener("submit", async function (e) {
            e.preventDefault();

            const usernameInput = document.getElementById("loginUsername");
            const passwordInput = document.getElementById("loginPassword");
            const error = document.getElementById("loginError");

            const username = usernameInput?.value.trim() || "";
            const password = passwordInput?.value || "";

            if (!supabaseClient) {
                if (error) {
                    error.textContent = "Library Supabase belum termuat.";
                    error.hidden = false;
                }
                return;
            }

            if (!username || !password) return;

            if (error) error.hidden = true;

            const submitButton = form.querySelector("button[type='submit']");
            if (submitButton) submitButton.disabled = true;

            try {
                const { data, error: authError } =
                    await supabaseClient.auth.signInWithPassword({
                        email: getSupabaseEmail(username),
                        password
                    });

                if (authError) throw authError;
                if (!data.user) throw new Error("Akun tidak ditemukan.");

                const profile = await loadOnlineProfile(data.user);

                if (!profile) {
                    await supabaseClient.auth.signOut();
                    throw new Error("Profil akun belum dibuat di database MedKas.");
                }

                if (profile.status !== "active") {
                    await supabaseClient.auth.signOut();
                    throw new Error("Akun ini sedang dinonaktifkan.");
                }

                onlineAdminCredentials =
                    profile.role === USER_ROLES.ADMIN
                        ? { username, password }
                        : null;

                const users = getManagedUsers();
                const cached = users.find(item => String(item.id) === String(profile.id));
                if (cached) {
                    cached.lastLogin = new Date().toISOString();
                    saveJSON(USER_MANAGEMENT_KEY, users, true);
                }

                await finishOnlineLogin(data.user, profile);

                if (error) error.hidden = true;
                if (typeof showToast === "function") {
                    showToast(`Login berhasil. Selamat datang, ${profile.full_name}!`);
                }

            } catch (err) {
                console.error(err);
                if (error) {
                    error.textContent =
                        onlineErrorText(err) === "Invalid login credentials"
                            ? "Username atau password salah."
                            : onlineErrorText(err);
                    error.hidden = false;
                }
                if (passwordInput) {
                    passwordInput.value = "";
                    passwordInput.focus();
                }
            } finally {
                if (submitButton) submitButton.disabled = false;
            }
        });
    }

    if (toggle) {
        toggle.addEventListener("click", function () {
            const password = document.getElementById("loginPassword");
            if (!password) return;

            if (password.type === "password") {
                password.type = "text";
                toggle.textContent = "🙈";
                toggle.setAttribute("aria-label", "Sembunyikan password");
            } else {
                password.type = "password";
                toggle.textContent = "👁️";
                toggle.setAttribute("aria-label", "Tampilkan password");
            }
        });
    }

    if (!supabaseClient) {
        showLoginScreen();
        return;
    }

    void (async () => {
        try {
            const { data } = await supabaseClient.auth.getSession();
            const authUser = data?.session?.user;

            if (!authUser) {
                showLoginScreen();
                return;
            }

            const profile = await loadOnlineProfile(authUser);

            if (!profile || profile.status !== "active") {
                await supabaseClient.auth.signOut();
                showLoginScreen();
                return;
            }

            onlineAdminCredentials = null;
            await finishOnlineLogin(authUser, profile);

        } catch (err) {
            console.error("Pemulihan sesi online gagal:", err);
            showLoginScreen();
        }
    })();
}


/* =========================================================
   PENGATURAN USERNAME & PASSWORD
   ========================================================= */

function initializeLoginSettings() {

    const form = document.getElementById("changeLoginForm");
    if (!form) return;

    form.addEventListener("submit", async function (e) {
        e.preventDefault();

        const usernameInput = document.getElementById("newLoginUsername");
        const oldPasswordInput = document.getElementById("oldLoginPassword");
        const newPasswordInput = document.getElementById("newLoginPassword");
        const confirmPasswordInput = document.getElementById("confirmLoginPassword");

        const username = usernameInput?.value.trim() || "";
        const oldPassword = oldPasswordInput?.value || "";
        const newPassword = newPasswordInput?.value || "";
        const confirmPassword = confirmPasswordInput?.value || "";

        if (!username || newPassword.length < 4 || newPassword !== confirmPassword) {
            showToast("Periksa username dan password baru.");
            return;
        }

        if (!supabaseClient || !onlineCurrentAuthUser) {
            showToast("Sesi online belum aktif.");
            return;
        }

        try {
            if (oldPassword) {
                const current = getCurrentManagedUser();
                if (!current) throw new Error("Profil pengguna tidak ditemukan.");
                const { error: verifyError } = await supabaseClient.auth.signInWithPassword({
                    email: getSupabaseEmail(current.username),
                    password: oldPassword
                });
                if (verifyError) throw new Error("Password lama salah.");
            }

            const { error } = await supabaseClient.auth.updateUser({
                email: getSupabaseEmail(username),
                password: newPassword
            });
            if (error) throw error;

            const { error: profileError } = await supabaseClient
                .from("user_profiles")
                .update({ username })
                .eq("id", onlineCurrentAuthUser.id);
            if (profileError) throw profileError;

            localStorage.setItem(LOGIN_USERNAME_KEY, username);
            localStorage.setItem(CURRENT_USER_KEY, username);
            form.reset();
            showToast("Akun berhasil diperbarui. Jika email confirmation aktif, konfirmasi email baru terlebih dahulu.");

        } catch (err) {
            console.error(err);
            showToast(onlineErrorText(err));
        }
    });
}

/* =========================================================
   STARTUP ONLINE
   ========================================================= */

initializeLogin();
initializeLoginSettings();
initializeDefaultAdmin();
initializeUserManagement();
updateRoleBasedMenu();

