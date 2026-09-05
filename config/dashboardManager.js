const pool = require('./database'); 
const { getDevices } = require('./genieacs'); 
class DashboardManager {
    formatBytes(bytes) {
        const b = Number(bytes) || 0; 
        if (b === 0) return '0 MB';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(b) / Math.log(k));
        return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    formatCurrency(amount) {
        return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
    }
    async getDashboardStats() {
        try {
            // Semua proses berjalan serentak tanpa antre
            const [genieDevices, dbStatsResult, routerListResult, trafficResult, topUsersResult] = await Promise.all([
                
                // 1. GenieACS diberi batas waktu 3 detik agar tidak bikin stuck
                Promise.race([
                    getDevices(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
                ]).catch(() => []), 
                
                pool.query(`
                    SELECT 
                        (SELECT COUNT(*) FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != '') as pppoe_total,
                        (SELECT COUNT(*) FROM radacct WHERE acctstoptime IS NULL AND username IN (SELECT pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != '')) as pppoe_active,
                        (SELECT COUNT(*) FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != '' AND status = 'suspended') as pppoe_suspend,
                        (SELECT COUNT(*) FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != '' AND status = 'terminate') as pppoe_terminate,
                        (SELECT COUNT(DISTINCT username) FROM radcheck WHERE username NOT IN (SELECT pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != '')) as hotspot_total,
                        (SELECT COUNT(*) FROM radacct WHERE acctstoptime IS NULL AND username NOT IN (SELECT pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != '')) as hotspot_active,
                        (SELECT COUNT(*) FROM nas) as total_routers,
                        COALESCE((SELECT SUM(amount) FROM payments WHERE amount > 0 AND MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())), 0) as monthly_income,
                        COALESCE((SELECT SUM(ABS(amount)) FROM payments WHERE amount < 0 AND MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())), 0) as monthly_expense,
                        COALESCE((SELECT SUM(amount) FROM payments WHERE MONTH(payment_date) = MONTH(CURRENT_DATE()) AND YEAR(payment_date) = YEAR(CURRENT_DATE())), 0) as net_profit,
                        COALESCE((SELECT SUM(amount) FROM payments WHERE amount > 0 AND MONTH(payment_date) = MONTH(CURRENT_DATE() - INTERVAL 1 MONTH) AND YEAR(payment_date) = YEAR(CURRENT_DATE() - INTERVAL 1 MONTH)), 0) as last_month_income,
                        (SELECT COUNT(*) FROM invoices WHERE status = 'unpaid') as unpaid_invoices,
                        (SELECT COUNT(*) FROM invoices WHERE status = 'unpaid' AND due_date < CURRENT_DATE()) as overdue_invoices,
                        (SELECT COUNT(*) FROM invoices WHERE status = 'paid' AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())) as total_transactions,
                        (SELECT COUNT(*) FROM invoices WHERE MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())) as total_invoices_month
                `),
                
                // 3. Ambil Router
                pool.query(`SELECT id, nasname, shortname, type FROM nas`),
                
                // 4. Ambil Trafik
                pool.query(`SELECT SUM(acctinputoctets) as up, SUM(acctoutputoctets) as dl FROM radacct WHERE acctstarttime >= CURDATE()`),
                
                // 5. Ambil Top User
                pool.query(`SELECT username, SUM(acctinputoctets + acctoutputoctets) as total_bytes FROM radacct WHERE acctstarttime >= CURDATE() GROUP BY username ORDER BY total_bytes DESC LIMIT 5`)
            ]);
            // Olah Data GenieACS
            let genieacsTotal = 0, genieacsOnline = 0, genieacsOffline = 0;
            if (Array.isArray(genieDevices) && genieDevices.length > 0) {
                genieacsTotal = genieDevices.length;
                const now = Date.now();
                genieacsOnline = genieDevices.filter(dev => dev._lastInform && (now - new Date(dev._lastInform).getTime()) < 3600*1000).length;
                genieacsOffline = genieacsTotal - genieacsOnline;
            }
            // Ekstrak Data SQL
            const stats = dbStatsResult[0][0] || {};
            const hotspotOffline = (stats.hotspot_total || 0) - (stats.hotspot_active || 0);
            return {
                genieacsTotal, 
                genieacsOnline, 
                genieacsOffline,
                
                hotspotTotal: stats.hotspot_total || 0,
                hotspotActive: stats.hotspot_active || 0,
                hotspotExpired: hotspotOffline > 0 ? hotspotOffline : 0, 
                
                mikrotikTotal: stats.pppoe_total || 0,
                mikrotikAktif: stats.pppoe_active || 0,
                mikrotikOffline: stats.pppoe_suspend || 0,
                mikrotikTerminate: stats.pppoe_terminate || 0,
                
                totalRouters: stats.total_routers || 0,
                routerList: routerListResult[0] || [], 
                
                monthlyIncome: this.formatCurrency(stats.monthly_income || 0),
                monthlyExpense: this.formatCurrency(stats.monthly_expense || 0),
                netProfit: this.formatCurrency(stats.net_profit || 0),
                lastMonthIncome: this.formatCurrency(stats.last_month_income || 0), 
                monthlyIncomeRaw: stats.monthly_income || 0, 
                
                unpaidInvoices: stats.unpaid_invoices || 0,
                overdueInvoices: stats.overdue_invoices || 0,
                totalTransactions: stats.total_transactions || 0,
                totalInvoicesMonth: stats.total_invoices_month || 0,
                
                totalUpload: this.formatBytes((trafficResult[0][0] && trafficResult[0][0].up) ? trafficResult[0][0].up : 0),
                totalDownload: this.formatBytes((trafficResult[0][0] && trafficResult[0][0].dl) ? trafficResult[0][0].dl : 0),
                
                topUsers: (topUsersResult[0] || []).map(user => ({
                    username: user.username,
                    usage: this.formatBytes(user.total_bytes)
                }))
            };
        } catch (error) {
            console.error('? Gagal ambil data Dashboard:', error.message);
            throw error; 
        }
    }
}
module.exports = new DashboardManager();
