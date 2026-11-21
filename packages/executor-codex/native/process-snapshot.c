#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void) {
    pid_t *processes = NULL;
    int count = 0;
    for (int attempt = 0; attempt < 4; attempt++) {
        int needed = proc_listallpids(NULL, 0);
        if (needed <= 0 || needed > 64000) return 1;
        int capacity = needed + 64;
        processes = calloc((size_t)capacity, sizeof(pid_t));
        if (!processes) return 1;
        count = proc_listallpids(processes, capacity * (int)sizeof(pid_t));
        if (count > 0 && count < capacity) break;
        free(processes);
        processes = NULL;
        if (count <= 0) return 1;
    }
    if (!processes) return 1;
    for (int index = 0; index < count; index++) {
        if (processes[index] <= 0) continue;
        struct proc_bsdinfo information;
        errno = 0;
        int bytes = proc_pidinfo(processes[index], PROC_PIDTBSDINFO, 0, &information, sizeof(information));
        if (bytes != sizeof(information)) {
            if (bytes == 0 && errno == ESRCH) continue;
            if (bytes != 0 || (errno != EPERM && errno != EACCES)) { free(processes); return 1; }
            struct proc_bsdshortinfo restricted;
            errno = 0;
            bytes = proc_pidinfo(processes[index], PROC_PIDT_SHORTBSDINFO, 0, &restricted, sizeof(restricted));
            if (bytes == 0 && errno == ESRCH) continue;
            if (bytes != sizeof(restricted) || restricted.pbsi_pid != (unsigned int)processes[index]) { free(processes); return 1; }
            printf("%u %u %u unavailable\n", restricted.pbsi_pid, restricted.pbsi_ppid, restricted.pbsi_pgid);
            continue;
        }
        if (information.pbi_pid != (unsigned int)processes[index]) { free(processes); return 1; }
        time_t started = (time_t)information.pbi_start_tvsec;
        struct tm calendar;
        char timestamp[64];
        if (!localtime_r(&started, &calendar) || !strftime(timestamp, sizeof(timestamp), "%a %b %e %H:%M:%S %Y", &calendar)) {
            free(processes);
            return 1;
        }
        printf("%u %u %u %s\n", information.pbi_pid, information.pbi_ppid, information.pbi_pgid, timestamp);
    }
    free(processes);
    return ferror(stdout) ? 1 : 0;
}
